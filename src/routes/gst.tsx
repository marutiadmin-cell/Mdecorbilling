import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  SalesRepo,
  PurchaseRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  CompanyRepo,
} from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";
import type { Invoice, Return } from "@/types";
import { fmtMoney, ymd, today } from "@/lib/format";
import { downloadElementAsPdf } from "@/lib/pdf";
import { downloadXlsx } from "@/lib/xlsx";
import { gstBuckets, hsnSummary, type GstBucket, type HsnBucket } from "@/lib/ledger";
import { stateFromGstin } from "@/lib/gstin";
import { useFinancialYear } from "@/store/financialYear";
import { isInFY } from "@/lib/fiscalYear";
import { FileText, FileDown, Sheet, ChevronLeft, ChevronRight } from "lucide-react";

export const Route = createFileRoute("/gst")({ component: GstPage });

type Bucket = GstBucket;

const currentPeriod = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// Month-input strings ("2026-07") parsed as local dates, not UTC — matches
// the ymd() convention used everywhere else so the period boundaries never
// drift a day off around midnight IST.
const periodRange = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return { start: ymd(new Date(y, m - 1, 1)), end: ymd(new Date(y, m, 0)) };
};

const periodLabel = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
};

const inPeriod = <T extends { date: string }>(docs: T[], start: string, end: string) =>
  docs.filter((d) => d.date >= start && d.date <= end);

function GstPage() {
  const _repoV = useRepoData();
  const { key: fyKey, from: fyFrom, to: fyTo } = useFinancialYear();
  const fyFromPeriod = fyFrom.slice(0, 7);
  const fyToPeriod = fyTo.slice(0, 7);
  // GST return periods are calendar months, but the natural starting point
  // is still fiscal-year-aware: the current month when today falls in the
  // selected FY, otherwise that FY's first return period (April).
  const [period, setPeriod] = useState(() =>
    isInFY(today(), fyKey) ? currentPeriod() : fyFromPeriod,
  );
  const [view, setView] = useState<"rate" | "hsn">("rate");
  const [sales, setSales] = useState<Invoice[]>([]);
  const [purchases, setPurchases] = useState<Invoice[]>([]);
  const [saleReturns, setSaleReturns] = useState<Return[]>([]);
  const [purchaseReturns, setPurchaseReturns] = useState<Return[]>([]);
  const printRef = useRef<HTMLDivElement>(null);

  // Follow the Topbar's Financial Year selector — jump the period, same rule
  // as the initial state above, whenever the selected FY actually changes.
  const prevFYKey = useRef(fyKey);
  useEffect(() => {
    if (prevFYKey.current !== fyKey) {
      setPeriod(isInFY(today(), fyKey) ? currentPeriod() : fyFromPeriod);
    }
    prevFYKey.current = fyKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fyKey]);

  // Chevrons stay within the selected FY's own 12 months (disabled, not
  // wrapping, at the edges) — manually typing a month in the input itself is
  // still unrestricted, for the rare case of checking a period outside the
  // active FY.
  const shiftPeriod = (delta: number) => {
    const [y, m] = period.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (next < fyFromPeriod || next > fyToPeriod) return;
    setPeriod(next);
  };
  const atFYStart = period <= fyFromPeriod;
  const atFYEnd = period >= fyToPeriod;

  useEffect(() => {
    setSales(SalesRepo.all());
    setPurchases(PurchaseRepo.all());
    setSaleReturns(SaleReturnRepo.all());
    setPurchaseReturns(PurchaseReturnRepo.all());
  }, [_repoV]);

  const { start, end } = periodRange(period);
  // The seller's own state, from their own GSTIN — one source, so this page
  // can never disagree with what a bill prints at the top of its own page.
  const sellerStateCode = stateFromGstin(CompanyRepo.get().gstin)?.code;

  const gstr1 = useMemo(
    () => gstBuckets(inPeriod(sales, start, end), inPeriod(saleReturns, start, end), sales, sellerStateCode),
    [sales, saleReturns, start, end, sellerStateCode],
  );
  const gstr2 = useMemo(
    () =>
      gstBuckets(
        inPeriod(purchases, start, end),
        inPeriod(purchaseReturns, start, end),
        purchases,
        sellerStateCode,
      ),
    [purchases, purchaseReturns, start, end, sellerStateCode],
  );

  const hsnOut = useMemo(
    () =>
      hsnSummary(inPeriod(sales, start, end), inPeriod(saleReturns, start, end), sales, sellerStateCode),
    [sales, saleReturns, start, end, sellerStateCode],
  );
  const hsnIn = useMemo(
    () =>
      hsnSummary(
        inPeriod(purchases, start, end),
        inPeriod(purchaseReturns, start, end),
        purchases,
        sellerStateCode,
      ),
    [purchases, purchaseReturns, start, end, sellerStateCode],
  );

  const outTotal = gstr1.reduce((s, r) => s + r.tax, 0);
  const inTotal = gstr2.reduce((s, r) => s + r.tax, 0);

  const handleDownloadPdf = async () => {
    if (!printRef.current) return;
    try {
      await downloadElementAsPdf(printRef.current, `GST-${period}`, "portrait");
      toast.success("GST summary downloaded as PDF");
    } catch {
      toast.error("Could not generate PDF");
    }
  };

  const handleDownloadExcel = () => {
    const sheetRows = (rows: Bucket[]) => [
      ["GST Rate", "Taxable Value", "CGST", "SGST", "IGST", "Total Tax"],
      ...rows.map((r) => [`${r.rate}%`, r.taxable, r.cgst, r.sgst, r.igst, r.tax]),
      [
        "Total",
        "",
        "",
        "",
        "",
        rows.reduce((s, r) => s + r.tax, 0),
      ],
    ];
    const hsnRows = (rows: HsnBucket[]) => [
      ["HSN/SAC", "GST Rate", "Qty", "Taxable Value", "CGST", "SGST", "IGST", "Total Tax"],
      ...rows.map((r) => [
        r.hsn || "(no HSN)",
        `${r.rate}%`,
        r.qty,
        r.taxable,
        r.cgst,
        r.sgst,
        r.igst,
        r.tax,
      ]),
    ];
    // Both tables always included regardless of which tab is on screen — a
    // GST return filing needs the rate-wise AND the HSN-wise breakup together,
    // not whichever one happened to be showing when this was clicked.
    downloadXlsx(`GST-${period}`, [
      { name: "GSTR-1 Sales", rows: sheetRows(gstr1) },
      { name: "GSTR-2 Purchase", rows: sheetRows(gstr2) },
      { name: "GSTR-1 HSN Summary", rows: hsnRows(hsnOut) },
      { name: "GSTR-2 HSN Summary", rows: hsnRows(hsnIn) },
    ]);
  };

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="GST"
        subtitle={`Output: ${fmtMoney(outTotal)} · Input: ${fmtMoney(inTotal)} · Payable: ${fmtMoney(outTotal - inTotal)}`}
        icon={<FileText className="h-5 w-5" />}
        actions={
          <>
            <div className="inline-flex items-center gap-1">
              <button
                onClick={() => shiftPeriod(-1)}
                disabled={atFYStart}
                className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition disabled:opacity-40 disabled:cursor-not-allowed"
                title="Previous month"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <input
                type="month"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className="h-8 border border-gray-200 rounded-md text-xs px-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
              />
              <button
                onClick={() => shiftPeriod(1)}
                disabled={atFYEnd}
                className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition disabled:opacity-40 disabled:cursor-not-allowed"
                title="Next month"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <button
              onClick={handleDownloadExcel}
              className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition"
              title="Download GST summary as Excel"
            >
              <Sheet className="h-4 w-4" />
            </button>
            <button
              onClick={handleDownloadPdf}
              className="h-8 w-8 shrink-0 rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 flex items-center justify-center transition"
              title="Download GST summary as PDF"
            >
              <FileDown className="h-4 w-4" />
            </button>
          </>
        }
      />
      <div ref={printRef} className="p-4 overflow-auto bg-white">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-semibold text-gray-600">{periodLabel(period)}</span>
          {/* Screen-only — the PDF export always captures whichever tab is
              showing, same as the rest of this page. */}
          <div className="inline-flex rounded-md border border-gray-200 bg-white overflow-hidden print:hidden">
            <button
              onClick={() => setView("rate")}
              className={`h-8 px-3 text-xs font-semibold transition ${view === "rate" ? "bg-primary text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
            >
              By Rate
            </button>
            <button
              onClick={() => setView("hsn")}
              className={`h-8 px-3 text-xs font-semibold transition ${view === "hsn" ? "bg-primary text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
            >
              HSN Summary
            </button>
          </div>
        </div>
        {view === "rate" ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Section title="GSTR-1 (Sales / Outward)" rows={gstr1} />
            <Section title="GSTR-2 (Purchase / Inward)" rows={gstr2} />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <HsnSection title="GSTR-1 HSN Summary (Outward)" rows={hsnOut} />
            <HsnSection title="GSTR-2 HSN Summary (Inward)" rows={hsnIn} />
          </div>
        )}
        <div className="mt-4 border rounded-md bg-card p-3 flex flex-wrap gap-6 text-sm">
          <div>
            <span className="text-muted-foreground">Output Tax: </span>
            <span className="font-semibold">{fmtMoney(outTotal)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Input Tax: </span>
            <span className="font-semibold">{fmtMoney(inTotal)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Net Payable: </span>
            <span className="font-semibold">{fmtMoney(outTotal - inTotal)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, rows }: { title: string; rows: Bucket[] }) {
  const total = rows.reduce((s, r) => s + r.tax, 0);
  return (
    <div className="border rounded-md bg-card">
      <div className="px-3 py-2 border-b font-semibold">{title}</div>
      {/* The mobile/desktop split below is screen-only — print must always
          show the real table regardless of the device it's triggered from,
          so this overrides both sides of the split back for @media print
          rather than trusting how a given browser resolves `md:` during an
          actual print render. */}
      <style>{`@media print {
        .gst-mobile-cards { display: none !important; }
        .gst-table { display: table !important; }
      }`}</style>
      {/* Mobile card list — a 5-column table is still tight on a phone;
          this is the same rate buckets as one card per GST rate instead. */}
      <div className="md:hidden gst-mobile-cards">
        {rows.length === 0 ? (
          <p className="text-center py-6 text-muted-foreground">No entries</p>
        ) : (
          <div className="divide-y">
            {rows.map((r) => (
              <div key={r.rate} className="p-3 flex items-center justify-between gap-3">
                <span className="font-medium">{r.rate}% GST</span>
                <div className="text-right text-xs text-muted-foreground">
                  <p>Taxable {fmtMoney(r.taxable)}</p>
                  <p>
                    {r.igst > 0
                      ? `IGST ${fmtMoney(r.igst)}`
                      : `CGST ${fmtMoney(r.cgst)} · SGST ${fmtMoney(r.sgst)}`}
                  </p>
                  <p className="font-semibold text-foreground">Tax {fmtMoney(r.tax)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="hidden md:block data-table gst-table">
        <table className="w-full text-[13px]">
          <thead>
            <tr>
              <th>GST Rate</th>
              <th style={{ textAlign: "right" }}>Taxable Value</th>
              <th style={{ textAlign: "right" }}>CGST</th>
              <th style={{ textAlign: "right" }}>SGST</th>
              <th style={{ textAlign: "right" }}>IGST</th>
              <th style={{ textAlign: "right" }}>Total Tax</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-6 text-muted-foreground">
                  No entries
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.rate}>
                  <td>{r.rate}%</td>
                  <td className="text-right">{fmtMoney(r.taxable)}</td>
                  <td className="text-right">{fmtMoney(r.cgst)}</td>
                  <td className="text-right">{fmtMoney(r.sgst)}</td>
                  <td className="text-right">{fmtMoney(r.igst)}</td>
                  <td className="text-right">{fmtMoney(r.tax)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="border-t p-2 flex justify-between font-semibold text-sm">
        <span>Total Tax</span>
        <span>{fmtMoney(total)}</span>
      </div>
    </div>
  );
}

/** Same shape as Section, grouped by HSN+rate instead of rate alone — the
 *  GSTR-1/GSTR-2 "HSN Summary" table. A blank HSN is shown as "(no HSN)"
 *  rather than left empty, so a gap in the item master reads as a worklist
 *  entry instead of something easy to miss. */
function HsnSection({ title, rows }: { title: string; rows: HsnBucket[] }) {
  const total = rows.reduce((s, r) => s + r.tax, 0);
  return (
    <div className="border rounded-md bg-card">
      <div className="px-3 py-2 border-b font-semibold">{title}</div>
      <style>{`@media print {
        .gst-hsn-mobile-cards { display: none !important; }
        .gst-hsn-table { display: table !important; }
      }`}</style>
      <div className="md:hidden gst-hsn-mobile-cards">
        {rows.length === 0 ? (
          <p className="text-center py-6 text-muted-foreground">No entries</p>
        ) : (
          <div className="divide-y">
            {rows.map((r) => (
              <div key={`${r.hsn}-${r.rate}`} className="p-3 flex items-center justify-between gap-3">
                <span className="font-medium">
                  {r.hsn || "(no HSN)"} · {r.rate}%
                </span>
                <div className="text-right text-xs text-muted-foreground">
                  <p>
                    Qty {r.qty} · Taxable {fmtMoney(r.taxable)}
                  </p>
                  <p>
                    {r.igst > 0
                      ? `IGST ${fmtMoney(r.igst)}`
                      : `CGST ${fmtMoney(r.cgst)} · SGST ${fmtMoney(r.sgst)}`}
                  </p>
                  <p className="font-semibold text-foreground">Tax {fmtMoney(r.tax)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="hidden md:block data-table gst-hsn-table">
        <table className="w-full text-[13px]">
          <thead>
            <tr>
              <th>HSN/SAC</th>
              <th style={{ textAlign: "right" }}>GST Rate</th>
              <th style={{ textAlign: "right" }}>Qty</th>
              <th style={{ textAlign: "right" }}>Taxable Value</th>
              <th style={{ textAlign: "right" }}>CGST</th>
              <th style={{ textAlign: "right" }}>SGST</th>
              <th style={{ textAlign: "right" }}>IGST</th>
              <th style={{ textAlign: "right" }}>Total Tax</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center py-6 text-muted-foreground">
                  No entries
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={`${r.hsn}-${r.rate}`}>
                  <td>{r.hsn || "(no HSN)"}</td>
                  <td className="text-right">{r.rate}%</td>
                  <td className="text-right">{r.qty}</td>
                  <td className="text-right">{fmtMoney(r.taxable)}</td>
                  <td className="text-right">{fmtMoney(r.cgst)}</td>
                  <td className="text-right">{fmtMoney(r.sgst)}</td>
                  <td className="text-right">{fmtMoney(r.igst)}</td>
                  <td className="text-right">{fmtMoney(r.tax)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="border-t p-2 flex justify-between font-semibold text-sm">
        <span>Total Tax</span>
        <span>{fmtMoney(total)}</span>
      </div>
    </div>
  );
}
