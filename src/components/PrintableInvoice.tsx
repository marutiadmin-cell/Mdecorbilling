import type { Invoice, Company } from "@/types";
import { fmtMoney, fmtDate } from "@/lib/format";
import { describePayment } from "@/lib/paymentSplit";
import { fmtMode } from "@/lib/paymentMode";

import { BankRepo } from "@/repositories";
import {
  stateFromGstin,
  supplyKind,
  splitTax,
  allocateAcrossRateBuckets,
  GST_STATES,
} from "@/lib/gstin";
/** An account's name for display. The word "Bank" three times over is
 *  exactly what a split is meant to stop being ambiguous. */
const bankName = (id: string) => BankRepo.get(id)?.name;

interface Props {
  inv: Invoice;
  company: Company;
  mode: "sale" | "purchase";
  /**
   * Overrides the heading when this layout is printing something that is not
   * a tax invoice — a quotation, a proforma.
   *
   * The heading is not decoration. TaxAdda is blunt about it: head a proforma
   * "Sales Invoice" and it becomes a legal document under GST. So the one
   * thing separating these documents on paper is passed in explicitly rather
   * than inferred from anything.
   */
  heading?: string;
  /** Printed under the totals — "This is not a tax invoice." */
  disclaimer?: string;
  /** "Valid until", where the price has a shelf life. */
  validUntil?: string;
  /** "print-area" (default) stays hidden until printed — used for the
   * always-mounted copy inside the create/edit form. Detail pages that show
   * this invoice on screen too should pass "print-visible" instead. */
  className?: string;
  /** Shrinks every font-size/padding/column-width proportionally — used to
   * fit two copies side by side on one landscape page. Deliberately NOT done
   * via CSS `zoom`: Chrome computes print page-breaks from the pre-zoom
   * layout size, so a zoomed block can get cut off mid-page even though it
   * visually looks like it fits — real layout-level scaling avoids that. */
  scale?: number;
  /** Printing onto pre-printed letterhead stationery — the company's own
   * name/address/logo is already physically on the paper, so the header
   * below is replaced with blank space reserved for it instead of printing
   * a second, redundant one. GSTIN still prints regardless: Rule 46 requires
   * it on the document itself, and a generic letterhead rarely carries it. */
  letterhead?: boolean;
}

// Number to words (Indian) - simple version
function numToWords(n: number): string {
  const a = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const inWords = (num: number): string => {
    if (num < 20) return a[num];
    if (num < 100) return b[Math.floor(num / 10)] + (num % 10 ? " " + a[num % 10] : "");
    if (num < 1000)
      return a[Math.floor(num / 100)] + " Hundred" + (num % 100 ? " " + inWords(num % 100) : "");
    if (num < 100000)
      return (
        inWords(Math.floor(num / 1000)) +
        " Thousand" +
        (num % 1000 ? " " + inWords(num % 1000) : "")
      );
    if (num < 10000000)
      return (
        inWords(Math.floor(num / 100000)) +
        " Lakh" +
        (num % 100000 ? " " + inWords(num % 100000) : "")
      );
    return (
      inWords(Math.floor(num / 10000000)) +
      " Crore" +
      (num % 10000000 ? " " + inWords(num % 10000000) : "")
    );
  };
  const rupees = Math.floor(n);
  const paise = Math.round((n - rupees) * 100);
  let s = inWords(rupees) + " Rupees";
  if (paise) s += " and " + inWords(paise) + " Paise";
  return s + " Only";
}

export function PrintableInvoice({
  inv,
  company,
  mode,
  className = "print-area",
  scale = 1,
  heading,
  disclaimer,
  validUntil,
  letterhead = false,
}: Props) {
  const gstOn = inv.gstEnabled !== false;
  // A4 portrait's printable content height (297mm page minus the 12mm
  // top+bottom print padding — see .print-area/.print-visible in
  // styles.css). The 2-up layout is landscape (210mm tall) with each copy
  // already shrunk to `scale`, so its floor scales the same way everything
  // else on that copy does. This is what makes a 2-line bill still fill a
  // full page with its signature anchored at the bottom, the way a real
  // invoice book does, instead of leaving the lower two-thirds of the page
  // visually blank under a table that stops after a handful of rows.
  const pageMinHeightMm = scale === 1 ? 297 - 24 : (210 - 24) * scale;
  const showDisc = inv.lineItems.some((l) => (l.discountPct ?? 0) > 0);

  // The line table has optional columns (Disc%, and GST%/GST Amt), so the
  // blank filler rows and the Item Total row MUST derive their cell counts
  // from the same flags as the header. Hard-coded counts are how the table
  // ended up with a phantom empty column hanging off the right edge.
  //   # · Item · [HSN] · Qty · Unit · Price · [Disc%] · [GST%] · [GST Amt] · Amount
  /* HSN/SAC is an item classification, not a tax figure — a Bill of Supply
     or a GST-off invoice can still carry it (customs/export paperwork, or a
     business that just wants it consistent across every document), so this
     depends only on whether a line actually has a code, never on whether
     GST happens to be on for THIS bill. An empty column on every bill of a
     shop that has never filled its HSN codes in is worse than no column. */
  const showHsn = inv.lineItems.some((l) => !!(l.hsn ?? "").trim());
  const colCount = 6 + (showHsn ? 1 : 0) + (showDisc ? 1 : 0) + (gstOn ? 2 : 0);
  // Item Total: "Item Total" spans # + Item + HSN (HSN sits BEFORE Qty in the
  // header, so it has to fold into this leading label, not the trailing
  // spacer below — putting it in the spacer instead left the Qty total
  // rendering one column early, directly under HSN/SAC instead of Qty).
  // Then Qty itself is shown, then this spacer covers everything up to (but
  // not including) GST Amt / Amount.
  const totalLabelSpan = 2 + (showHsn ? 1 : 0);
  const totalSpacerSpan = 2 + (showDisc ? 1 : 0) + (gstOn ? 1 : 0);
  const isSale = mode === "sale";
  const title =
    heading ?? (gstOn ? "TAX INVOICE" : isSale ? "INVOICE / BILL OF SUPPLY" : "PURCHASE BILL");

  /* Which tax this bill carries.
     The seller's state is whatever their own GSTIN says — one source, so it
     cannot drift from the number printed at the top of the page. The buyer's
     is the place of supply recorded ON THE BILL when it was written, falling
     back to the GSTIN it was billed to. Both unknown means intra-state, which
     is what every invoice written before this printed. */
  const sellerState = stateFromGstin(company.gstin)?.code;
  const buyerState = inv.placeOfSupply || stateFromGstin(inv.partyGstin)?.code;
  const kind = supplyKind(sellerState, buyerState);
  const interstate = kind === "inter";

  // Aggregate GST by rate for summary — for a GST-compliant bill
  // (taxCalcVersion 2), Extra Discount/Shipping are folded in via the exact
  // same allocation that produced inv.taxAmount, so this sub-table's
  // rate-by-rate split still sums to what "Total GST" shows further down
  // (which reads inv.taxAmount directly, a frozen historical fact, not
  // recomputed here). A bill saved before this existed never had that
  // fold-in, so its buckets stay pure per-line — exactly what it always
  // printed; reprinting it later must never show different numbers than the
  // original printout did.
  const gstBuckets: Record<string, { taxable: number; tax: number }> = {};
  let taxableTotal = 0;
  // Sum of the printed "Amount" column (taxable + GST per line) — must match
  // the line-items table footer exactly, since that footer is not the same
  // figure as the Grand Total below (which also applies Extra Discount/Round Off).
  let lineAmountTotal = 0;
  const byRate = new Map<number, number>();
  inv.lineItems.forEach((l) => {
    const taxable = l.qty * l.price * (1 - l.discountPct / 100);
    taxableTotal += taxable;
    const gstAmt = gstOn ? taxable * (l.gstRate / 100) : 0;
    lineAmountTotal += taxable + gstAmt;
    if (gstOn) byRate.set(l.gstRate, (byRate.get(l.gstRate) ?? 0) + taxable);
  });
  if (gstOn) {
    const buckets = Array.from(byRate, ([rate, taxable]) => ({ rate, taxable }));
    const adjusted =
      inv.taxCalcVersion === 2
        ? allocateAcrossRateBuckets(buckets, (inv.shippingCharge ?? 0) - inv.discount)
        : buckets.map((b) => ({ ...b, tax: b.taxable * (b.rate / 100) }));
    for (const b of adjusted) gstBuckets[b.rate.toString()] = { taxable: b.taxable, tax: b.tax };
  }

  const totalQty = inv.lineItems.reduce((s, l) => s + l.qty, 0);

  // Every font-size / padding / column-width number below goes through this,
  // so `scale` genuinely shrinks the rendered layout instead of just the
  // visual appearance.
  const s = (n: number) => Math.round(n * scale * 10) / 10;

  const cellStyle: React.CSSProperties = {
    border: "1px solid #000",
    padding: `${s(6)}px ${s(8)}px`,
    fontSize: s(11),
  };
  const th: React.CSSProperties = {
    ...cellStyle,
    background: "#f0f0f0",
    fontWeight: 700,
    textAlign: "left",
  };

  return (
    <div
      className={className}
      style={{
        fontFamily: "Arial, sans-serif",
        color: "#000",
        // Deliberately NOT `display: flex` (and no footer-anchoring trick)
        // here — an inline style always wins over a stylesheet rule,
        // including .print-area's own `display: none` (what keeps this
        // embedded copy invisible until actually printed). Setting display
        // inline collided with that and made the hidden print copy render on
        // top of the real form on screen. `minHeight` alone is safe — it has
        // zero effect on a `display: none` element — so the page still
        // reaches a full A4 height instead of stopping short, just without
        // trying to pin the footer to its exact bottom edge.
        minHeight: `${pageMinHeightMm}mm`,
      }}
    >
      {/* Header — on letterhead stationery the company's own name/address/
          logo AND the "TAX INVOICE"/GSTIN heading are already physically
          printed on the paper as part of the letterhead's own fixed design,
          so this entire block is left blank (sized to roughly clear that
          pre-printed band) instead of printing a redundant second copy of
          any of it. This is specifically how THIS business's letterhead is
          designed — a letterhead that does NOT already carry its own GSTIN
          would need it printed here instead, which is what the non-letterhead
          branch below still does. */}
      {letterhead ? (
        // A real letterhead's own printed header occupies genuine physical
        // space — a 60px gap was barely distinguishable from no gap at all.
        // This reserves an actual ~40mm band (scaled down the same way the
        // 2-up copy is), a realistic approximation of a typical letterhead
        // header height, not a font-proportional spacing value.
        <div style={{ height: `${40 * scale}mm` }} />
      ) : (
      <div
        style={{
          textAlign: "center",
          borderBottom: "2px solid #000",
          paddingBottom: s(8),
          marginBottom: s(8),
        }}
      >
        <div style={{ fontSize: s(10), fontWeight: 700, letterSpacing: s(1.5) }}>{title}</div>
        <div style={{ fontSize: s(22), fontWeight: 800, marginTop: s(3) }}>
          {company.name || "Your Company"}
        </div>
        {company.address && <div style={{ fontSize: s(11) }}>{company.address}</div>}
        <div style={{ fontSize: s(11) }}>
          {company.phone && <>Phone: {company.phone}</>}
          {company.phone && company.email && " · "}
          {company.email && <>Email: {company.email}</>}
        </div>
        {gstOn && company.gstin && (
          <div style={{ fontSize: s(11), fontWeight: 600 }}>GSTIN: {company.gstin}</div>
        )}
      </div>
      )}

      {/* Party + Invoice meta */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: s(8) }}>
        <tbody>
          <tr>
            <td style={{ ...cellStyle, verticalAlign: "top" }}>
              <div style={{ fontSize: s(10), color: "#555", fontWeight: 600, marginBottom: s(3) }}>
                {isSale ? "BILL TO" : "SUPPLIER"}
              </div>
              <div style={{ fontSize: s(14), fontWeight: 700 }}>{inv.partyName || "—"}</div>
              {inv.partyAddress && <div>{inv.partyAddress}</div>}
              {inv.partyPhone && <div>Phone: {inv.partyPhone}</div>}
              {gstOn && inv.partyGstin && (
                <div style={{ fontWeight: 600 }}>GSTIN: {inv.partyGstin}</div>
              )}
              {gstOn && (inv.partyState || buyerState) && (
                <div>
                  Place of Supply: {buyerState ? `${buyerState} — ` : ""}
                  {inv.partyState ?? (buyerState ? GST_STATES[buyerState] : "")}
                </div>
              )}
            </td>
            <td style={{ ...cellStyle, width: "1%", whiteSpace: "nowrap", verticalAlign: "top" }}>
              <table style={{ width: "auto", fontSize: s(11) }}>
                <tbody>
                  <tr>
                    <td style={{ fontWeight: 600, paddingRight: s(6) }}>
                      {heading ? "No." : "Invoice #"}:
                    </td>
                    <td>{inv.number}</td>
                  </tr>
                  {/* Rule 46 requires a tax invoice to STATE whether tax is
                      payable on reverse charge. Printed either way, because
                      silence is not an answer a return can be checked
                      against. */}
                  {gstOn && (
                    <tr>
                      <td style={{ fontWeight: 600, paddingRight: s(6) }}>Reverse Charge:</td>
                      <td>{inv.reverseCharge ? "Yes" : "No"}</td>
                    </tr>
                  )}
                  {!!validUntil && (
                    <tr>
                      <td style={{ fontWeight: 600, paddingRight: s(6) }}>Valid until:</td>
                      <td>{fmtDate(validUntil)}</td>
                    </tr>
                  )}
                  <tr>
                    <td style={{ fontWeight: 600 }}>Date:</td>
                    <td>{fmtDate(inv.date)}</td>
                  </tr>
                  <tr>
                    <td style={{ fontWeight: 600 }}>Payment:</td>
                    <td>{describePayment(inv, bankName)}</td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
          {/* A separate "Ship To" row — only when it actually differs from
              the billing address above, matching how every other billing
              app shows this (QuickBooks, Zoho). Leaving it off when they
              match (or when nothing was entered) is what every invoice
              before this field existed already printed, so nothing changes
              for a document that never used it. Purchase bills don't get
              this: a supplier has a billing address, not a delivery one. */}
          {isSale &&
            !!inv.shipToAddress?.trim() &&
            inv.shipToAddress.trim() !== (inv.partyAddress ?? "").trim() && (
              <tr>
                <td style={{ ...cellStyle, verticalAlign: "top" }} colSpan={2}>
                  <div
                    style={{ fontSize: s(10), color: "#555", fontWeight: 600, marginBottom: s(3) }}
                  >
                    SHIP TO
                  </div>
                  <div>{inv.shipToAddress}</div>
                </td>
              </tr>
            )}
        </tbody>
      </table>

      {/* Line items */}
      {/* Sale bills no longer collect a per-line discount (the whole-bill
          Extra Discount covers it), so printing a column of "0%" is just
          noise. Shown only when a line actually carries one — which keeps
          every older bill that DID use line discounts printing exactly as
          it always has. */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...th, width: s(28), textAlign: "center" }}>#</th>
            <th style={th}>Item</th>
            {showHsn && <th style={{ ...th, width: s(60) }}>HSN/SAC</th>}
            <th style={{ ...th, textAlign: "right", width: s(55) }}>Qty</th>
            <th style={{ ...th, width: s(45) }}>Unit</th>
            <th style={{ ...th, textAlign: "right", width: s(75) }}>Price</th>
            {showDisc && <th style={{ ...th, textAlign: "right", width: s(55) }}>Disc%</th>}
            {gstOn && <th style={{ ...th, textAlign: "right", width: s(55) }}>GST%</th>}
            {gstOn && <th style={{ ...th, textAlign: "right", width: s(75) }}>GST Amt</th>}
            <th style={{ ...th, textAlign: "right", width: s(90) }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {inv.lineItems.map((l, i) => {
            const taxable = l.qty * l.price * (1 - l.discountPct / 100);
            const gstAmt = gstOn ? taxable * (l.gstRate / 100) : 0;
            return (
              <tr key={l.id}>
                <td style={{ ...cellStyle, textAlign: "center" }}>{i + 1}</td>
                <td style={cellStyle}>{l.name}</td>
                {showHsn && <td style={cellStyle}>{l.hsn ?? ""}</td>}
                <td style={{ ...cellStyle, textAlign: "right" }}>{l.qty}</td>
                <td style={cellStyle}>{l.unit}</td>
                <td style={{ ...cellStyle, textAlign: "right" }}>{fmtMoney(l.price)}</td>
                {showDisc && <td style={{ ...cellStyle, textAlign: "right" }}>{l.discountPct}%</td>}
                {gstOn && <td style={{ ...cellStyle, textAlign: "right" }}>{l.gstRate}%</td>}
                {gstOn && <td style={{ ...cellStyle, textAlign: "right" }}>{fmtMoney(gstAmt)}</td>}
                <td style={{ ...cellStyle, textAlign: "right", fontWeight: 600 }}>
                  {fmtMoney(taxable + gstAmt)}
                </td>
              </tr>
            );
          })}
          {/* filler — padded to a more generous minimum than the item count
              alone would need, closer to how a real invoice book's printed
              grid fills the page even for a short bill (and, same as a
              carbon invoice book, leaves no blank row where a line could be
              added by hand after the bill was signed). */}
          {inv.lineItems.length < 12 &&
            Array.from({ length: 12 - inv.lineItems.length }).map((_, i) => (
              <tr key={"e" + i}>
                {Array.from({ length: colCount }).map((__, c) => (
                  <td key={c} style={c === 0 ? { ...cellStyle, height: s(20) } : cellStyle}>
                    {c === 0 ? " " : ""}
                  </td>
                ))}
              </tr>
            ))}
          <tr>
            <td style={{ ...cellStyle, fontWeight: 700 }} colSpan={totalLabelSpan}>
              Item Total
            </td>
            <td style={{ ...cellStyle, textAlign: "right", fontWeight: 700 }}>{totalQty}</td>
            <td style={cellStyle} colSpan={totalSpacerSpan}></td>
            {gstOn && (
              <td style={{ ...cellStyle, textAlign: "right", fontWeight: 700 }}>
                {fmtMoney(Object.values(gstBuckets).reduce((s, b) => s + b.tax, 0))}
              </td>
            )}
            <td style={{ ...cellStyle, textAlign: "right", fontWeight: 700 }}>
              {fmtMoney(lineAmountTotal)}
            </td>
          </tr>
        </tbody>
      </table>

      {/* Totals + tax summary */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: s(8) }}>
        <tbody>
          <tr>
            <td style={{ ...cellStyle, width: "58%", verticalAlign: "top" }}>
              <div style={{ fontSize: s(10), fontWeight: 700, marginBottom: s(4) }}>
                Amount in Words
              </div>
              <div style={{ fontSize: s(11), fontStyle: "italic" }}>{numToWords(inv.total)}</div>
              {inv.notes && (
                <>
                  <div
                    style={{
                      fontSize: s(10),
                      fontWeight: 700,
                      marginTop: s(8),
                      marginBottom: s(3),
                    }}
                  >
                    Notes
                  </div>
                  <div style={{ fontSize: s(11) }}>{inv.notes}</div>
                </>
              )}
              {gstOn && Object.keys(gstBuckets).length > 0 && (
                <div style={{ marginTop: s(8) }}>
                  <div style={{ fontSize: s(10), fontWeight: 700, marginBottom: s(3) }}>
                    Tax Summary
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: s(10) }}>
                    <thead>
                      <tr>
                        <th style={th}>GST %</th>
                        <th style={{ ...th, textAlign: "right" }}>Taxable</th>
                        {interstate ? (
                          <th style={{ ...th, textAlign: "right" }}>IGST</th>
                        ) : (
                          <>
                            <th style={{ ...th, textAlign: "right" }}>CGST</th>
                            <th style={{ ...th, textAlign: "right" }}>SGST</th>
                          </>
                        )}
                        <th style={{ ...th, textAlign: "right" }}>Total Tax</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(gstBuckets).map(([rate, v]) => (
                        <tr key={rate}>
                          <td style={cellStyle}>{rate}%</td>
                          <td style={{ ...cellStyle, textAlign: "right" }}>
                            {fmtMoney(v.taxable)}
                          </td>
                          {/* One place decides the split, and it is the same
                              one the totals use — halving here independently
                              is how a bill ends up disagreeing with itself by
                              a paisa. */}
                          {(() => {
                            const sp = splitTax(v.tax, kind);
                            return interstate ? (
                              <td style={{ ...cellStyle, textAlign: "right" }}>
                                {fmtMoney(sp.igst)}
                              </td>
                            ) : (
                              <>
                                <td style={{ ...cellStyle, textAlign: "right" }}>
                                  {fmtMoney(sp.cgst)}
                                </td>
                                <td style={{ ...cellStyle, textAlign: "right" }}>
                                  {fmtMoney(sp.sgst)}
                                </td>
                              </>
                            );
                          })()}
                          <td style={{ ...cellStyle, textAlign: "right" }}>{fmtMoney(v.tax)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </td>
            <td style={{ ...cellStyle, verticalAlign: "top", padding: 0 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: s(12) }}>
                <tbody>
                  <tr>
                    <td style={{ padding: `${s(5)}px ${s(8)}px` }}>Subtotal</td>
                    <td style={{ padding: `${s(5)}px ${s(8)}px`, textAlign: "right" }}>
                      {fmtMoney(taxableTotal)}
                    </td>
                  </tr>
                  {inv.discount > 0 && (
                    <tr>
                      <td style={{ padding: `${s(5)}px ${s(8)}px` }}>Discount</td>
                      <td style={{ padding: `${s(5)}px ${s(8)}px`, textAlign: "right" }}>
                        - {fmtMoney(inv.discount)}
                      </td>
                    </tr>
                  )}
                  {gstOn && (
                    <tr>
                      <td style={{ padding: `${s(5)}px ${s(8)}px` }}>Total GST</td>
                      <td style={{ padding: `${s(5)}px ${s(8)}px`, textAlign: "right" }}>
                        {fmtMoney(inv.taxAmount)}
                      </td>
                    </tr>
                  )}
                  {!!inv.shippingCharge && inv.shippingCharge > 0 && (
                    <tr>
                      <td style={{ padding: `${s(5)}px ${s(8)}px` }}>Shipping Charge</td>
                      <td style={{ padding: `${s(5)}px ${s(8)}px`, textAlign: "right" }}>
                        {fmtMoney(inv.shippingCharge)}
                      </td>
                    </tr>
                  )}
                  {!!inv.roundOff && Math.abs(inv.roundOff) > 0.001 && (
                    <tr>
                      <td style={{ padding: `${s(5)}px ${s(8)}px` }}>Round Off</td>
                      <td style={{ padding: `${s(5)}px ${s(8)}px`, textAlign: "right" }}>
                        {inv.roundOff > 0 ? "+" : "−"} {fmtMoney(Math.abs(inv.roundOff))}
                      </td>
                    </tr>
                  )}
                  <tr style={{ background: "#f0f0f0", fontWeight: 800, fontSize: s(14) }}>
                    <td style={{ padding: s(8), borderTop: "2px solid #000" }}>Grand Total</td>
                    <td style={{ padding: s(8), textAlign: "right", borderTop: "2px solid #000" }}>
                      {fmtMoney(inv.total)}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: `${s(5)}px ${s(8)}px` }}>Paid</td>
                    <td style={{ padding: `${s(5)}px ${s(8)}px`, textAlign: "right" }}>
                      {fmtMoney(inv.paid)}
                    </td>
                  </tr>
                  <tr style={{ fontWeight: 700 }}>
                    <td style={{ padding: `${s(5)}px ${s(8)}px`, borderTop: "1px solid #000" }}>
                      Balance {inv.total - inv.paid > 0 ? "Due" : "Paid"}
                    </td>
                    <td
                      style={{
                        padding: `${s(5)}px ${s(8)}px`,
                        textAlign: "right",
                        borderTop: "1px solid #000",
                      }}
                    >
                      {fmtMoney(Math.abs(inv.total - inv.paid))}
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Footer */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: s(20) }}>
        <tbody>
          <tr>
            <td
              style={{
                width: "50%",
                fontSize: s(10),
                verticalAlign: "top",
                paddingRight: s(12),
              }}
            >
              {!!disclaimer && (
                <div
                  style={{
                    marginBottom: s(6),
                    padding: s(5),
                    border: "1px solid #999",
                    fontWeight: 700,
                    fontSize: s(10),
                  }}
                >
                  {disclaimer}
                </div>
              )}
              <div style={{ fontWeight: 700, marginBottom: s(4) }}>Terms &amp; Conditions</div>
              <div>1. Goods once sold will not be taken back.</div>
              <div>2. Interest @18% p.a. will be charged on delayed payments.</div>
              <div>3. Subject to local jurisdiction.</div>
            </td>
            <td
              style={{
                width: "50%",
                textAlign: "right",
                verticalAlign: "bottom",
                paddingTop: s(40),
              }}
            >
              <div
                style={{
                  borderTop: "1px solid #000",
                  display: "inline-block",
                  paddingTop: s(4),
                  minWidth: s(200),
                  fontSize: s(11),
                  fontWeight: 600,
                }}
              >
                For {company.name || "Company"}
                <br />
                <span style={{ fontWeight: 400, fontSize: s(10) }}>Authorised Signatory</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
