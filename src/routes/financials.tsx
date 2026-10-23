import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { BsAccountRepo, CompanyRepo, areReposHydrated } from "@/repositories";
import { useRepoData, useRepoMemo } from "@/hooks/useRepoData";
import { usePermissions } from "@/hooks/usePermissions";
import { useFinancialYear } from "@/store/financialYear";
import { buildFinancials, type AgedParty, type Financials, type Line } from "@/lib/financials";
import { normalizeLedger, type SuspenseNote } from "@/lib/postings";
import { finInputFromRepos } from "@/lib/finData";
import { fmtMoney, fmtDate } from "@/lib/format";
import { downloadXlsx } from "@/lib/xlsx";
import { downloadElementAsPdf } from "@/lib/pdf";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/Field";
import {
  Scale,
  FileDown,
  FileSpreadsheet,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  SlidersHorizontal,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/financials")({ component: FinancialsPage });

type Tab = "itr" | "tformat" | "pl" | "trial" | "schedules" | "checks";
const TABS: { key: Tab; label: string }[] = [
  { key: "itr", label: "Balance Sheet (ITR-3)" },
  { key: "tformat", label: "Balance Sheet (T-format)" },
  { key: "pl", label: "Trading & P&L" },
  { key: "trial", label: "Trial Balance" },
  { key: "schedules", label: "Schedules" },
  { key: "checks", label: "Checks" },
];

const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (l: { amount: number }[]) => r2(l.reduce((s, x) => s + x.amount, 0));
/** Money with a sign the CA reads: negatives in brackets. */
const money = (n: number) => (n < 0 ? `(${fmtMoney(-n)})` : fmtMoney(n));

function FinancialsPage() {
  const { isOwner } = usePermissions();
  const _repoV = useRepoData();
  const fy = useFinancialYear();
  const [tab, setTab] = useState<Tab>("itr");
  const [asAt, setAsAt] = useState(fy.to);
  const printRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  // A new year picked in the top bar starts at that year's end.
  useEffect(() => setAsAt(fy.to), [fy.to]);
  const clamped = asAt < fy.from ? fy.from : asAt > fy.to ? fy.to : asAt;

  const hydrated = areReposHydrated();
  const data = useRepoMemo(() => {
    if (!areReposHydrated()) return null;
    const input = finInputFromRepos();
    return { f: buildFinancials(input, fy.from, clamped), input };
  }, [fy.from, clamped, hydrated]);
  void _repoV;

  if (!isOwner) return null;
  const company = CompanyRepo.get().name || "Business";

  if (!data) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Balance Sheet" icon={<Scale className="h-5 w-5" />} />
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading every record first — a balance sheet
          from half the data would be wrong…
        </div>
      </div>
    );
  }
  const { f, input } = data;
  const unclassified = unclassifiedLedgers(input);
  const suspenseCount = f.suspenseDr.length + f.suspenseCr.length;

  const exportExcel = async () => {
    setBusy(true);
    try {
      await downloadXlsx(
        `balance-sheet-${fy.label.replace(/\s+/g, "")}-${clamped}`,
        excelSheets(f, company),
      );
    } finally {
      setBusy(false);
    }
  };
  const exportPdf = async () => {
    if (!printRef.current) return;
    setBusy(true);
    try {
      await downloadElementAsPdf(
        printRef.current,
        `${TABS.find((t) => t.key === tab)?.label} ${fy.label}`,
        tab === "tformat" || tab === "pl" ? "landscape" : "portrait",
      );
    } catch {
      toast.error("Could not make the PDF — try Excel instead");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Balance Sheet"
        subtitle={`${company} · as at ${fmtDate(clamped)} · ${fy.label} · for the CA`}
        icon={<Scale className="h-5 w-5" />}
        actions={
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="outline" disabled={busy} onClick={exportExcel}>
              <FileSpreadsheet className="h-3.5 w-3.5" /> Excel (all)
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={exportPdf}>
              <FileDown className="h-3.5 w-3.5" /> PDF
            </Button>
          </div>
        }
      />
      <div className="px-4 md:px-6 pt-3 flex flex-wrap items-end gap-3">
        <div className="w-44">
          <Field
            label="As at"
            type="date"
            min={fy.from}
            max={fy.to}
            value={clamped}
            onChange={(e) => e.target.value && setAsAt(e.target.value)}
          />
        </div>
        <div className="flex gap-1 flex-wrap" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`h-8 px-3 rounded-md text-[12.5px] font-medium border transition ${tab === t.key ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground hover:text-foreground"}`}
            >
              {t.label}
              {t.key === "checks" && (f.difference !== 0 || suspenseCount > 0) && (
                <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-amber-500" />
              )}
            </button>
          ))}
        </div>
      </div>

      {(f.difference !== 0 || suspenseCount > 0 || unclassified.length > 0) && tab !== "checks" && (
        <div className="mx-4 md:mx-6 mt-3 rounded-md border border-amber-200 bg-amber-50 text-amber-800 px-3 py-2 text-[12.5px] flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            {f.difference !== 0 ? `Out of balance by ${fmtMoney(Math.abs(f.difference))}. ` : ""}
            {suspenseCount > 0 ? `${suspenseCount} amount(s) are in Suspense. ` : ""}
            {unclassified.length > 0
              ? `${unclassified.length} journal-voucher ledger(s) need a group. `
              : ""}
          </span>
          <button className="ml-auto font-semibold underline" onClick={() => setTab("checks")}>
            See Checks
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 md:p-6">
        <div
          ref={printRef}
          className="print-visible bg-white rounded-lg border p-4 md:p-6 max-w-5xl"
        >
          <div className="text-center mb-4">
            <p className="text-[16px] font-bold">{company}</p>
            <p className="text-[12px] text-muted-foreground">
              {TABS.find((t) => t.key === tab)?.label} —{" "}
              {tab === "pl" ? `${fmtDate(f.from)} to ${fmtDate(f.to)}` : `as at ${fmtDate(f.to)}`}
            </p>
          </div>
          {tab === "itr" && <ItrBalanceSheet f={f} />}
          {tab === "tformat" && <TBalanceSheet f={f} />}
          {tab === "pl" && <TradingPL f={f} />}
          {tab === "trial" && <TrialBalance f={f} />}
          {tab === "schedules" && <Schedules f={f} />}
          {tab === "checks" && (
            <Checks f={f} suspense={input.books.suspense} unclassified={unclassified} />
          )}
          <p className="text-[10.5px] text-muted-foreground mt-6 leading-relaxed">
            Stock valued at cost, moving weighted average (AS-2); GST input credit excluded from
            cost. Profit here is the periodic Trading & P&L method and can differ from the quick P&L
            on the Reports page, which costs each sale at the item's cost when sold. Prepared from
            the books in this app; to be reviewed by the Chartered Accountant.
          </p>
        </div>
      </div>
    </div>
  );
}

function unclassifiedLedgers(input: ReturnType<typeof finInputFromRepos>): string[] {
  const known = new Set(BsAccountRepo.all().map((a) => normalizeLedger(a.name)));
  const out = new Map<string, string>();
  for (const p of input.books.postings) {
    if (!p.account.startsWith("ledger:")) continue;
    const k = p.account.slice("ledger:".length);
    if (!known.has(k)) out.set(k, input.books.names.get(p.account) ?? k);
  }
  return [...out.values()].sort();
}

/* ── Building blocks ─────────────────────────────────────────────────── */

function Row({
  label,
  amount,
  level = 0,
  bold,
  total,
  muted,
}: {
  label: React.ReactNode;
  amount?: number;
  level?: number;
  bold?: boolean;
  total?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 py-1 text-[12.5px] ${total ? "border-t border-gray-300 font-bold mt-0.5" : ""} ${bold ? "font-semibold" : ""} ${muted ? "text-muted-foreground" : ""}`}
      style={{ paddingLeft: level * 16 }}
    >
      <span className="min-w-0">{label}</span>
      {amount !== undefined && (
        <span className="tabular-nums whitespace-nowrap">{money(amount)}</span>
      )}
    </div>
  );
}

const Lines = ({ lines, level = 2 }: { lines: Line[]; level?: number }) => (
  <>
    {lines.map((l) => (
      <Row key={l.account ?? l.label} label={l.label} amount={l.amount} level={level} muted />
    ))}
  </>
);

/** Every figure the two balance-sheet layouts share, worked out once. */
function bsFigures(f: Financials) {
  const L = f.ledgers;
  const secured = r2(sum(L.securedLoan) + sum(f.bankOverdraft));
  const unsecured = sum(L.unsecuredLoan);
  const advancesFrom = sum(f.advancesFromCustomers);
  const reserves = sum(L.reserves);
  const suspenseCr = sum(f.suspenseCr);
  const fixed = sum(L.fixedAsset);
  const invest = sum(L.investment);
  const debtors = sum(f.debtors);
  const cashBank = sum(f.cashBank);
  const loansAdv = r2(sum(L.loansAdvances) + sum(f.advancesToSuppliers) + f.gstCredit);
  const otherCA = sum(L.otherCurrentAsset);
  const currentAssets = r2(f.closingStock + debtors + cashBank + loansAdv + otherCA);
  const creditors = sum(f.creditors);
  const duties = r2(f.gstPayable + sum(L.dutiesTaxes));
  const otherCL = sum(L.otherCurrentLiability);
  const provisions = sum(L.provision);
  const currentLiabilities = r2(creditors + duties + otherCL + provisions);
  const suspenseDr = sum(f.suspenseDr);
  const sources = r2(
    f.capital.closing + reserves + secured + unsecured + advancesFrom + suspenseCr,
  );
  const application = r2(fixed + invest + currentAssets - currentLiabilities + suspenseDr);
  return {
    secured,
    unsecured,
    advancesFrom,
    reserves,
    suspenseCr,
    fixed,
    invest,
    debtors,
    cashBank,
    loansAdv,
    otherCA,
    currentAssets,
    creditors,
    duties,
    otherCL,
    provisions,
    currentLiabilities,
    suspenseDr,
    sources,
    application,
  };
}

const overOneYear = (l: AgedParty[]) => r2(l.reduce((s, x) => s + x.overOneYear, 0));

/* ── ITR-3 Part A-BS ─────────────────────────────────────────────────── */

function ItrBalanceSheet({ f }: { f: Financials }) {
  const x = bsFigures(f);
  const L = f.ledgers;
  return (
    <div className="grid gap-5">
      <div>
        <p className="text-[12px] font-bold uppercase tracking-wide text-primary mb-1">
          I. Sources of funds
        </p>
        <Row label="1. Proprietor's fund" bold />
        <Row label="a. Proprietor's capital" amount={f.capital.closing} level={1} />
        <Row label="b. Reserves and surplus" amount={x.reserves} level={1} />
        <Lines lines={L.reserves} />
        <Row
          label="Total proprietor's fund"
          amount={r2(f.capital.closing + x.reserves)}
          level={1}
          total
        />
        <Row label="2. Loan funds" bold />
        <Row label="a. Secured loans" amount={x.secured} level={1} />
        <Lines lines={[...L.securedLoan, ...f.bankOverdraft]} />
        <Row label="b. Unsecured loans" amount={x.unsecured} level={1} />
        <Lines lines={L.unsecuredLoan} />
        <Row label="Total loan funds" amount={r2(x.secured + x.unsecured)} level={1} total />
        <Row label="3. Advances (from customers)" amount={x.advancesFrom} bold />
        {x.suspenseCr !== 0 && (
          <Row label="4. Suspense (to be classified)" amount={x.suspenseCr} bold />
        )}
        <Row label="Total sources of funds" amount={x.sources} total />
      </div>
      <div>
        <p className="text-[12px] font-bold uppercase tracking-wide text-primary mb-1">
          II. Application of funds
        </p>
        <Row label="1. Fixed assets (net block)" amount={x.fixed} bold />
        <Lines lines={L.fixedAsset} level={1} />
        <Row label="2. Investments" amount={x.invest} bold />
        <Lines lines={L.investment} level={1} />
        <Row label="3. Current assets, loans and advances" bold />
        <Row label="a. Inventories" amount={f.closingStock} level={1} />
        <Row label="Raw materials" amount={f.closingStockByKind.raw} level={2} muted />
        <Row label="Stock-in-process" amount={0} level={2} muted />
        <Row label="Finished goods" amount={f.closingStockByKind.finished} level={2} muted />
        <Row
          label="Stock-in-trade (traded goods)"
          amount={f.closingStockByKind.trading}
          level={2}
          muted
        />
        <Row label="b. Sundry debtors" amount={x.debtors} level={1} />
        <Row
          label="Outstanding for more than one year"
          amount={overOneYear(f.debtors)}
          level={2}
          muted
        />
        <Row label="Others" amount={r2(x.debtors - overOneYear(f.debtors))} level={2} muted />
        <Row label="c. Cash and bank balances" amount={x.cashBank} level={1} />
        <Lines lines={f.cashBank} />
        <Row label="d. Loans and advances" amount={x.loansAdv} level={1} />
        <Lines lines={L.loansAdvances} />
        {f.advancesToSuppliers.length > 0 && (
          <Row label="Advances to suppliers" amount={sum(f.advancesToSuppliers)} level={2} muted />
        )}
        {f.gstCredit > 0 && (
          <Row
            label="Balance with revenue authorities (GST input credit)"
            amount={f.gstCredit}
            level={2}
            muted
          />
        )}
        <Row label="e. Other current assets" amount={x.otherCA} level={1} />
        <Lines lines={L.otherCurrentAsset} />
        <Row label="Total current assets (A)" amount={x.currentAssets} level={1} total />
        <Row label="Less: current liabilities and provisions" level={1} bold />
        <Row label="a. Sundry creditors" amount={x.creditors} level={2} />
        <Row
          label="Outstanding for more than one year"
          amount={overOneYear(f.creditors)}
          level={3}
          muted
        />
        <Row label="b. Duties and taxes" amount={x.duties} level={2} />
        {f.gstPayable > 0 && (
          <Row label="GST payable (output − input)" amount={f.gstPayable} level={3} muted />
        )}
        <Lines lines={L.dutiesTaxes} level={3} />
        <Row label="c. Other current liabilities" amount={x.otherCL} level={2} />
        <Lines lines={L.otherCurrentLiability} level={3} />
        <Row label="d. Provisions" amount={x.provisions} level={2} />
        <Lines lines={L.provision} level={3} />
        <Row label="Total current liabilities (B)" amount={x.currentLiabilities} level={1} total />
        <Row
          label="Net current assets (A − B)"
          amount={r2(x.currentAssets - x.currentLiabilities)}
          bold
        />
        {x.suspenseDr !== 0 && (
          <Row label="4. Suspense (to be classified)" amount={x.suspenseDr} bold />
        )}
        <Row label="Total application of funds" amount={x.application} total />
      </div>
      <Balanced a={x.sources} b={x.application} />
    </div>
  );
}

function Balanced({ a, b }: { a: number; b: number }) {
  const ok = Math.abs(a - b) < 0.005;
  return (
    <p
      className={`text-[12px] flex items-center gap-1.5 ${ok ? "text-emerald-700" : "text-rose-600"}`}
    >
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
      {ok ? "Balanced — both sides agree." : `Out of balance by ${fmtMoney(Math.abs(a - b))}`}
    </p>
  );
}

/* ── Two-sided layouts ───────────────────────────────────────────────── */

function TwoSides({
  left,
  right,
  leftTitle,
  rightTitle,
  leftTotal,
  rightTotal,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
  leftTitle: string;
  rightTitle: string;
  leftTotal: number;
  rightTotal: number;
}) {
  return (
    <div className="grid md:grid-cols-2 gap-0 border rounded-md overflow-hidden">
      <div className="p-3 md:border-r flex flex-col">
        <p className="text-[12px] font-bold uppercase tracking-wide text-primary mb-1">
          {leftTitle}
        </p>
        <div className="flex-1">{left}</div>
        <Row label="Total" amount={leftTotal} total />
      </div>
      <div className="p-3 flex flex-col border-t md:border-t-0">
        <p className="text-[12px] font-bold uppercase tracking-wide text-primary mb-1">
          {rightTitle}
        </p>
        <div className="flex-1">{right}</div>
        <Row label="Total" amount={rightTotal} total />
      </div>
    </div>
  );
}

function TBalanceSheet({ f }: { f: Financials }) {
  const x = bsFigures(f);
  const L = f.ledgers;
  const c = f.capital;
  const liabilities = r2(x.sources + x.currentLiabilities);
  const assets = r2(x.fixed + x.invest + x.currentAssets + x.suspenseDr);
  return (
    <div className="grid gap-3">
      <TwoSides
        leftTitle="Liabilities"
        rightTitle="Assets"
        leftTotal={liabilities}
        rightTotal={assets}
        left={
          <>
            <Row label="Capital account" bold />
            <Row label="Opening balance" amount={c.opening} level={1} muted />
            {c.introduced !== 0 && (
              <Row label="Add: capital introduced" amount={c.introduced} level={1} muted />
            )}
            {c.adjustments !== 0 && (
              <Row
                label="Add/(less): cash & bank adjustments"
                amount={c.adjustments}
                level={1}
                muted
              />
            )}
            <Row
              label={c.netProfit >= 0 ? "Add: net profit" : "Less: net loss"}
              amount={c.netProfit}
              level={1}
              muted
            />
            {c.drawings !== 0 && (
              <Row label="Less: drawings" amount={-c.drawings} level={1} muted />
            )}
            <Row label="Closing capital" amount={c.closing} level={1} bold />
            {x.reserves !== 0 && <Row label="Reserves and surplus" amount={x.reserves} bold />}
            {x.secured !== 0 && <Row label="Secured loans" amount={x.secured} bold />}
            <Lines lines={[...L.securedLoan, ...f.bankOverdraft]} level={1} />
            {x.unsecured !== 0 && <Row label="Unsecured loans" amount={x.unsecured} bold />}
            <Lines lines={L.unsecuredLoan} level={1} />
            <Row label="Sundry creditors" amount={x.creditors} bold />
            {x.advancesFrom !== 0 && (
              <Row label="Advances from customers" amount={x.advancesFrom} bold />
            )}
            {x.duties !== 0 && <Row label="Duties and taxes" amount={x.duties} bold />}
            {x.otherCL !== 0 && <Row label="Other current liabilities" amount={x.otherCL} bold />}
            {x.provisions !== 0 && <Row label="Provisions" amount={x.provisions} bold />}
            {x.suspenseCr !== 0 && <Row label="Suspense" amount={x.suspenseCr} bold />}
          </>
        }
        right={
          <>
            {x.fixed !== 0 && <Row label="Fixed assets" amount={x.fixed} bold />}
            <Lines lines={L.fixedAsset} level={1} />
            {x.invest !== 0 && <Row label="Investments" amount={x.invest} bold />}
            <Row label="Closing stock" amount={f.closingStock} bold />
            <Row label="Raw materials" amount={f.closingStockByKind.raw} level={1} muted />
            <Row label="Finished goods" amount={f.closingStockByKind.finished} level={1} muted />
            <Row label="Traded goods" amount={f.closingStockByKind.trading} level={1} muted />
            <Row label="Sundry debtors" amount={x.debtors} bold />
            <Row label="Cash and bank" amount={x.cashBank} bold />
            <Lines lines={f.cashBank} level={1} />
            {x.loansAdv !== 0 && <Row label="Loans and advances" amount={x.loansAdv} bold />}
            {x.otherCA !== 0 && <Row label="Other current assets" amount={x.otherCA} bold />}
            {x.suspenseDr !== 0 && <Row label="Suspense" amount={x.suspenseDr} bold />}
          </>
        }
      />
      <Balanced a={liabilities} b={assets} />
    </div>
  );
}

function TradingPL({ f }: { f: Financials }) {
  const netPurch = r2(f.purchases - f.purchaseReturns);
  const netSales = r2(f.sales - f.salesReturns);
  const directTotal = sum(f.directExpenses);
  const gp = f.grossProfit;
  const tradingDr = r2(f.openingStock + netPurch + directTotal + Math.max(0, gp));
  const tradingCr = r2(netSales + f.closingStock + Math.max(0, -gp));
  const indirect = sum(f.indirectExpenses);
  const other = sum(f.otherIncome);
  const np = f.netProfit;
  const plDr = r2(Math.max(0, -gp) + indirect + f.discountAllowed + Math.max(0, np));
  const plCr = r2(Math.max(0, gp) + f.discountReceived + other + Math.max(0, -np));
  return (
    <div className="grid gap-4">
      <p className="text-[13px] font-semibold">Trading account</p>
      <TwoSides
        leftTitle="Dr"
        rightTitle="Cr"
        leftTotal={tradingDr}
        rightTotal={tradingCr}
        left={
          <>
            <Row label="Opening stock" amount={f.openingStock} bold />
            <Row label="Purchases (excl. GST)" amount={f.purchases} />
            <Row label="Less: purchase returns" amount={-f.purchaseReturns} level={1} muted />
            <Row label="Direct expenses" amount={directTotal} />
            <Lines lines={f.directExpenses} level={1} />
            {gp >= 0 && <Row label="Gross profit c/d" amount={gp} bold />}
          </>
        }
        right={
          <>
            <Row label="Sales (excl. GST)" amount={f.sales} />
            <Row label="Less: sales returns" amount={-f.salesReturns} level={1} muted />
            <Row label="Closing stock" amount={f.closingStock} bold />
            {gp < 0 && <Row label="Gross loss c/d" amount={-gp} bold />}
          </>
        }
      />
      <Balanced a={tradingDr} b={tradingCr} />
      <p className="text-[13px] font-semibold mt-2">Profit &amp; loss account</p>
      <TwoSides
        leftTitle="Dr"
        rightTitle="Cr"
        leftTotal={plDr}
        rightTotal={plCr}
        left={
          <>
            {gp < 0 && <Row label="Gross loss b/d" amount={-gp} bold />}
            <Row label="Expenses" amount={indirect} bold />
            <Lines lines={f.indirectExpenses} level={1} />
            {f.discountAllowed !== 0 && <Row label="Discount allowed" amount={f.discountAllowed} />}
            {np >= 0 && <Row label="Net profit (to capital)" amount={np} bold />}
          </>
        }
        right={
          <>
            {gp >= 0 && <Row label="Gross profit b/d" amount={gp} bold />}
            {f.discountReceived !== 0 && (
              <Row label="Discount received" amount={f.discountReceived} />
            )}
            {other !== 0 && <Row label="Other income" amount={other} />}
            <Lines lines={f.otherIncome} level={1} />
            {np < 0 && <Row label="Net loss (to capital)" amount={-np} bold />}
          </>
        }
      />
      <Balanced a={plDr} b={plCr} />
    </div>
  );
}

function TrialBalance({ f }: { f: Financials }) {
  const dr = r2(f.trial.reduce((s, t) => s + t.debit, 0));
  const cr = r2(f.trial.reduce((s, t) => s + t.credit, 0));
  return (
    <div className="grid gap-2">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-1.5 font-medium">Account</th>
            <th className="py-1.5 font-medium text-right w-36">Debit</th>
            <th className="py-1.5 font-medium text-right w-36">Credit</th>
          </tr>
        </thead>
        <tbody>
          {f.trial.map((t) => (
            <tr key={t.account} className="border-b border-gray-100">
              <td className="py-1">{t.label}</td>
              <td className="py-1 text-right tabular-nums">{t.debit ? fmtMoney(t.debit) : ""}</td>
              <td className="py-1 text-right tabular-nums">{t.credit ? fmtMoney(t.credit) : ""}</td>
            </tr>
          ))}
          <tr className="font-bold border-t-2">
            <td className="py-1.5">Total</td>
            <td className="py-1.5 text-right tabular-nums">{fmtMoney(dr)}</td>
            <td className="py-1.5 text-right tabular-nums">{fmtMoney(cr)}</td>
          </tr>
        </tbody>
      </table>
      <p className="text-[11px] text-muted-foreground">
        Balance-sheet accounts at their closing balance; income and expense for the year; capital
        brought forward and opening stock as at the start of the year. Closing stock (
        {fmtMoney(f.closingStock)}) is outside the trial balance, as usual.
      </p>
      <Balanced a={dr} b={cr} />
    </div>
  );
}

/* ── Schedules ───────────────────────────────────────────────────────── */

function Table({
  head,
  rows,
  foot,
}: {
  head: string[];
  rows: (string | number)[][];
  foot?: (string | number)[];
}) {
  const cell = (v: string | number, i: number) =>
    typeof v === "number" ? (
      <td key={i} className="py-1 px-1.5 text-right tabular-nums whitespace-nowrap">
        {money(v)}
      </td>
    ) : (
      <td key={i} className="py-1 px-1.5">
        {v}
      </td>
    );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b text-muted-foreground">
            {head.map((h, i) => (
              <th
                key={h}
                className={`py-1.5 px-1.5 font-medium ${i === 0 ? "text-left" : "text-right"}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-gray-100">
              {r.map(cell)}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={head.length} className="py-2 px-1.5 text-muted-foreground">
                None
              </td>
            </tr>
          )}
        </tbody>
        {foot && (
          <tfoot>
            <tr className="font-semibold border-t">{foot.map(cell)}</tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

const Sched = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mb-5">
    <p className="text-[13px] font-semibold mb-1">{title}</p>
    {children}
  </section>
);

const qty = (n: number) => String(Math.round(n * 100) / 100);

function Schedules({ f }: { f: Financials }) {
  const c = f.capital;
  const partyRows = (l: AgedParty[]) => l.map((p) => [p.name, p.overOneYear, p.amount]);
  const partyFoot = (l: AgedParty[]) => ["Total", overOneYear(l), sum(l)];
  return (
    <div>
      <Sched title="1. Capital account">
        <Table
          head={["", "Amount"]}
          rows={[
            ["Opening balance", c.opening],
            ["Add: capital introduced (journal vouchers)", c.introduced],
            ["Add/(less): cash & bank adjustments not classified", c.adjustments],
            ["Add: net profit / (less: net loss)", c.netProfit],
            ["Less: drawings", -c.drawings],
          ]}
          foot={["Closing balance", c.closing]}
        />
      </Sched>
      <Sched title="2. Sundry debtors">
        <Table
          head={["Party", "Over 1 year", "Amount"]}
          rows={partyRows(f.debtors)}
          foot={partyFoot(f.debtors)}
        />
      </Sched>
      <Sched title="3. Sundry creditors">
        <Table
          head={["Party", "Over 1 year", "Amount"]}
          rows={partyRows(f.creditors)}
          foot={partyFoot(f.creditors)}
        />
      </Sched>
      {(f.advancesFromCustomers.length > 0 || f.advancesToSuppliers.length > 0) && (
        <Sched title="4. Advances">
          <Table
            head={["Party", "From customer", "To supplier"]}
            rows={[
              ...f.advancesFromCustomers.map((p) => [p.name, p.amount, ""]),
              ...f.advancesToSuppliers.map((p) => [p.name, "", p.amount]),
            ]}
          />
        </Sched>
      )}
      <Sched title="5. Cash and bank balances">
        <Table
          head={["Account", "Balance"]}
          rows={[...f.cashBank, ...f.bankOverdraft.map((b) => ({ ...b, amount: -b.amount }))].map(
            (l) => [l.label, l.amount],
          )}
          foot={["Total", r2(sum(f.cashBank) - sum(f.bankOverdraft))]}
        />
      </Sched>
      <Sched title="6. Fixed assets and depreciation">
        <Table
          head={[
            "Asset",
            "Rate %",
            "Opening",
            "Additions",
            "Deductions",
            "Depreciation",
            "Closing",
          ]}
          rows={f.fixedAssets.map((a) => [
            a.name,
            `${a.rate}%`,
            a.opening,
            a.additions,
            a.deductions,
            a.depreciation,
            a.closing,
          ])}
          foot={[
            "Total",
            "",
            r2(f.fixedAssets.reduce((s, a) => s + a.opening, 0)),
            r2(f.fixedAssets.reduce((s, a) => s + a.additions, 0)),
            r2(f.fixedAssets.reduce((s, a) => s + a.deductions, 0)),
            r2(f.fixedAssets.reduce((s, a) => s + a.depreciation, 0)),
            r2(f.fixedAssets.reduce((s, a) => s + a.closing, 0)),
          ]}
        />
      </Sched>
      <Sched title="7. Loans">
        <Table
          head={["Loan", "Balance"]}
          rows={[
            ...f.ledgers.securedLoan.map((l) => [`${l.label} (secured)`, l.amount]),
            ...f.bankOverdraft.map((l) => [l.label, l.amount]),
            ...f.ledgers.unsecuredLoan.map((l) => [`${l.label} (unsecured)`, l.amount]),
          ]}
        />
      </Sched>
      <Sched title="8. Closing stock (moving average cost)">
        <Table
          head={["Item", "Type", "Qty", "Rate", "Value"]}
          rows={f.stockAtClose.items
            .filter((p) => p.qty !== 0 || p.value !== 0)
            .map((p) => [p.name, KIND[p.kind], `${qty(p.qty)} ${p.unit}`, p.rate, p.value])}
          foot={["Total", "", "", "", f.closingStock]}
        />
      </Sched>
      <Sched title="9. Quantitative details">
        <div className="overflow-x-auto">
          <table className="w-full text-[11.5px]">
            <thead>
              <tr className="border-b text-muted-foreground">
                {[
                  "Item",
                  "Opening",
                  "Purchased",
                  "Produced",
                  "Returned in",
                  "Sold",
                  "Consumed",
                  "Returned out",
                  "Adjusted",
                  "Closing",
                ].map((h, i) => (
                  <th
                    key={h}
                    className={`py-1.5 px-1 font-medium ${i ? "text-right" : "text-left"}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {f.quantities.map((q) => (
                <tr key={q.itemId} className="border-b border-gray-100">
                  <td className="py-1 px-1">
                    {q.name} <span className="text-muted-foreground">({q.unit})</span>
                  </td>
                  {[
                    q.opening,
                    q.purchased,
                    q.produced,
                    q.returnedIn,
                    q.sold,
                    q.consumed,
                    q.returnedOut,
                    q.adjusted,
                    q.closing,
                  ].map((n, i) => (
                    <td key={i} className="py-1 px-1 text-right tabular-nums">
                      {n ? qty(n) : ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Sched>
    </div>
  );
}

const KIND: Record<string, string> = {
  raw: "Raw material",
  finished: "Finished",
  trading: "Traded",
};

/* ── Checks ──────────────────────────────────────────────────────────── */

function Checks({
  f,
  suspense,
  unclassified,
}: {
  f: Financials;
  suspense: SuspenseNote[];
  unclassified: string[];
}) {
  const negStock = f.stockAtClose.items.filter((p) => p.qty < 0);
  const noCost = f.stockAtClose.items.filter((p) => p.qty > 0 && p.rate === 0);
  const negCash = f.cashBank.filter((l) => l.amount < 0);
  const notes = suspense.filter((s) => s.date === "" || s.date <= f.to);
  const Item = ({
    ok,
    title,
    children,
  }: {
    ok: boolean;
    title: string;
    children?: React.ReactNode;
  }) => (
    <div
      className={`rounded-md border px-3 py-2 ${ok ? "border-emerald-200 bg-emerald-50/50" : "border-amber-200 bg-amber-50/60"}`}
    >
      <p
        className={`text-[13px] font-semibold flex items-center gap-1.5 ${ok ? "text-emerald-800" : "text-amber-800"}`}
      >
        {ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        {title}
      </p>
      {children && <div className="text-[12px] mt-1 text-foreground/80">{children}</div>}
    </div>
  );
  return (
    <div className="grid gap-2.5">
      <Item
        ok={f.difference === 0}
        title={
          f.difference === 0
            ? "Assets = liabilities + capital, to the paisa"
            : `Out of balance by ${fmtMoney(Math.abs(f.difference))}`
        }
      />
      <Item
        ok={unclassified.length === 0}
        title={
          unclassified.length
            ? `${unclassified.length} journal-voucher ledger(s) have no group — they sit in Suspense`
            : "Every journal-voucher ledger is classified"
        }
      >
        {unclassified.length > 0 && (
          <>
            {unclassified.join(", ")}.{" "}
            <Link
              to="/balance-sheet-setup"
              className="text-primary font-medium inline-flex items-center gap-1"
            >
              <SlidersHorizontal className="h-3 w-3" /> Classify them
            </Link>
          </>
        )}
      </Item>
      <Item
        ok={notes.length === 0}
        title={
          notes.length
            ? `${notes.length} document(s) posted to Suspense`
            : "No document needed a Suspense entry"
        }
      >
        {notes.length > 0 && (
          <ul className="list-disc pl-5 space-y-0.5">
            {notes.slice(0, 40).map((n, i) => (
              <li key={i}>
                {n.date ? `${fmtDate(n.date)} · ` : ""}
                {n.doc.label} — {n.why}
                {n.amount ? ` (${fmtMoney(Math.abs(n.amount) / 100)})` : ""}
              </li>
            ))}
            {notes.length > 40 && <li>…and {notes.length - 40} more</li>}
          </ul>
        )}
      </Item>
      <Item
        ok={negStock.length === 0}
        title={
          negStock.length
            ? `${negStock.length} item(s) below zero stock — valued at 0`
            : "No item below zero stock"
        }
      >
        {negStock.length > 0 &&
          negStock
            .slice(0, 30)
            .map((p) => `${p.name} (${qty(p.qty)} ${p.unit})`)
            .join(", ")}
      </Item>
      <Item
        ok={noCost.length === 0}
        title={
          noCost.length
            ? `${noCost.length} item(s) in stock with no cost — valued at 0`
            : "Every item in stock has a cost"
        }
      >
        {noCost.length > 0 &&
          noCost
            .slice(0, 30)
            .map((p) => p.name)
            .join(", ")}
      </Item>
      <Item
        ok={negCash.length === 0}
        title={
          negCash.length
            ? "A cash or bank figure is negative — check missing entries"
            : "Cash and bank are not negative"
        }
      >
        {negCash.map((l) => `${l.label}: ${money(l.amount)}`).join("; ")}
      </Item>
    </div>
  );
}

/* ── Excel ───────────────────────────────────────────────────────────── */

function excelSheets(f: Financials, company: string) {
  const x = bsFigures(f);
  const head = (t: string): (string | number)[][] => [[company], [t], []];
  const L = f.ledgers;
  const ln = (lines: Line[], indent = "    ") => lines.map((l) => [indent + l.label, l.amount]);
  const bs: (string | number)[][] = [
    ...head(`Balance Sheet (ITR-3 Part A-BS) as at ${f.to}`),
    ["I. SOURCES OF FUNDS", ""],
    ["Proprietor's capital", f.capital.closing],
    ["Reserves and surplus", x.reserves],
    ["Secured loans", x.secured],
    ...ln([...L.securedLoan, ...f.bankOverdraft]),
    ["Unsecured loans", x.unsecured],
    ...ln(L.unsecuredLoan),
    ["Advances from customers", x.advancesFrom],
    ["Suspense (credit)", x.suspenseCr],
    ["TOTAL SOURCES", x.sources],
    [],
    ["II. APPLICATION OF FUNDS", ""],
    ["Fixed assets (net)", x.fixed],
    ...ln(L.fixedAsset),
    ["Investments", x.invest],
    ["Inventories", f.closingStock],
    ["    Raw materials", f.closingStockByKind.raw],
    ["    Finished goods", f.closingStockByKind.finished],
    ["    Stock-in-trade", f.closingStockByKind.trading],
    ["Sundry debtors", x.debtors],
    ["    of which over one year", overOneYear(f.debtors)],
    ["Cash and bank", x.cashBank],
    ...ln(f.cashBank),
    ["Loans and advances", x.loansAdv],
    ["Other current assets", x.otherCA],
    ["Total current assets (A)", x.currentAssets],
    ["Sundry creditors", x.creditors],
    ["Duties and taxes", x.duties],
    ["Other current liabilities", x.otherCL],
    ["Provisions", x.provisions],
    ["Total current liabilities (B)", x.currentLiabilities],
    ["Net current assets (A − B)", r2(x.currentAssets - x.currentLiabilities)],
    ["Suspense (debit)", x.suspenseDr],
    ["TOTAL APPLICATION", x.application],
  ];
  const pl: (string | number)[][] = [
    ...head(`Trading and Profit & Loss account ${f.from} to ${f.to}`),
    ["Opening stock", f.openingStock],
    ["Purchases (excl. GST)", f.purchases],
    ["Less: purchase returns", -f.purchaseReturns],
    ...f.directExpenses.map((l) => [`Direct: ${l.label}`, l.amount]),
    ["Sales (excl. GST)", f.sales],
    ["Less: sales returns", -f.salesReturns],
    ["Closing stock", f.closingStock],
    ["GROSS PROFIT", f.grossProfit],
    ...f.indirectExpenses.map((l) => [`Expense: ${l.label}`, -l.amount]),
    ["Discount allowed", -f.discountAllowed],
    ["Discount received", f.discountReceived],
    ...f.otherIncome.map((l) => [`Income: ${l.label}`, l.amount]),
    ["NET PROFIT", f.netProfit],
    [],
    ["CAPITAL ACCOUNT", ""],
    ["Opening", f.capital.opening],
    ["Capital introduced", f.capital.introduced],
    ["Cash & bank adjustments", f.capital.adjustments],
    ["Net profit", f.capital.netProfit],
    ["Drawings", -f.capital.drawings],
    ["Closing", f.capital.closing],
  ];
  const trial: (string | number)[][] = [
    ...head(`Trial balance as at ${f.to}`),
    ["Account", "Debit", "Credit"],
    ...f.trial.map((t) => [t.label, t.debit || "", t.credit || ""]),
    [
      "Total",
      r2(f.trial.reduce((s, t) => s + t.debit, 0)),
      r2(f.trial.reduce((s, t) => s + t.credit, 0)),
    ],
  ];
  const parties = (title: string, l: AgedParty[]): (string | number)[][] => [
    ...head(title),
    ["Party", "Over 1 year", "Amount"],
    ...l.map((p) => [p.name, p.overOneYear, p.amount]),
    ["Total", overOneYear(l), sum(l)],
  ];
  const stock: (string | number)[][] = [
    ...head(`Closing stock as at ${f.to} (moving average cost)`),
    ["Item", "Type", "Qty", "Unit", "Rate", "Value"],
    ...f.stockAtClose.items
      .filter((p) => p.qty || p.value)
      .map((p) => [p.name, KIND[p.kind], p.qty, p.unit, p.rate, p.value]),
    ["Total", "", "", "", "", f.closingStock],
  ];
  const qtys: (string | number)[][] = [
    ...head(`Quantitative details ${f.from} to ${f.to}`),
    [
      "Item",
      "Unit",
      "Opening",
      "Purchased",
      "Produced",
      "Returned in",
      "Sold",
      "Consumed",
      "Returned out",
      "Adjusted",
      "Closing",
    ],
    ...f.quantities.map((q) => [
      q.name,
      q.unit,
      q.opening,
      q.purchased,
      q.produced,
      q.returnedIn,
      q.sold,
      q.consumed,
      q.returnedOut,
      q.adjusted,
      q.closing,
    ]),
  ];
  const fixed: (string | number)[][] = [
    ...head(`Fixed assets ${f.from} to ${f.to}`),
    ["Asset", "Rate %", "Opening", "Additions", "Deductions", "Depreciation", "Closing"],
    ...f.fixedAssets.map((a) => [
      a.name,
      a.rate,
      a.opening,
      a.additions,
      a.deductions,
      a.depreciation,
      a.closing,
    ]),
  ];
  return [
    { name: "Balance Sheet", rows: bs },
    { name: "Trading & PL", rows: pl },
    { name: "Trial Balance", rows: trial },
    { name: "Debtors", rows: parties(`Sundry debtors as at ${f.to}`, f.debtors) },
    { name: "Creditors", rows: parties(`Sundry creditors as at ${f.to}`, f.creditors) },
    { name: "Stock", rows: stock },
    { name: "Quantities", rows: qtys },
    { name: "Fixed Assets", rows: fixed },
  ];
}
