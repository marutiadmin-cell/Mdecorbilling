/**
 * Financial statements for a sole proprietor: Trial Balance, Trading and
 * Profit & Loss account, Balance Sheet (ITR-3 "Part A-BS" headings and the
 * classic two-sided layout), and the schedules a CA asks for.
 *
 * Everything is a sum of the postings from lib/postings.ts plus the stock
 * figures from lib/stockValuation.ts, and the arithmetic is arranged so the
 * statements balance BY CONSTRUCTION:
 *
 *   opening capital  = everything owned − everything owed, the day before
 *                      the period (so prior years' profit is already in it)
 *   net profit       = periodic method: sales − (opening stock + purchases
 *                      + direct costs − closing stock) − expenses …
 *   closing capital  = opening + profit + introduced − drawings
 *
 * and closing capital is then checked against what the balance sheet
 * actually holds (assets − liabilities at the closing date). Every document
 * balances, so the two are equal to the paisa; the "difference" is computed
 * and shown anyway, never hidden — if it is ever not zero, something is
 * posting outside these rules and the Checks screen says what.
 *
 * Note: this profit is NOT the quick P&L on the Reports page. That one costs
 * each sale at the item's cost when it was sold; this one is the CA's
 * periodic method with stock valued at moving-average cost. They agree
 * when costs are stable and drift apart when prices move — which is why a CA
 * files from this one.
 */
import type {
  BankAccount,
  BsAccount,
  BsGroup,
  ExpenseClass,
  FinConfig,
  ItemKind,
  Party,
} from "@/types";
import {
  ACC,
  SUSPENSE_LABEL,
  balances,
  normalizeLedger,
  paise,
  type Books,
  type DocRef,
  type Posting,
} from "@/lib/postings";
import { stockSnapshots, type StockData, type StockSnapshot } from "@/lib/stockValuation";

/* ── Dates ─────────────────────────────────────────────────────────────── */

export function dayBefore(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) - 86400000);
  return t.toISOString().slice(0, 10);
}
const daysBetween = (a: string, b: string) => {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
};

/* ── Classification ───────────────────────────────────────────────────── */

export const BS_GROUP_LABEL: Record<BsGroup, string> = {
  capital: "Capital (introduced / withdrawn)",
  drawings: "Drawings",
  reserves: "Reserves & surplus",
  securedLoan: "Secured loan",
  unsecuredLoan: "Unsecured loan",
  otherCurrentLiability: "Other current liability",
  provision: "Provision",
  dutiesTaxes: "Duties & taxes",
  fixedAsset: "Fixed asset",
  investment: "Investment",
  loansAdvances: "Loans & advances (given)",
  otherCurrentAsset: "Other current asset",
  otherIncome: "Other income",
  indirectExpense: "Indirect expense (P&L)",
  directExpense: "Direct expense (Trading)",
};

const ASSET_GROUPS: BsGroup[] = ["fixedAsset", "investment", "loansAdvances", "otherCurrentAsset"];
const LIABILITY_GROUPS: BsGroup[] = [
  "reserves",
  "securedLoan",
  "unsecuredLoan",
  "otherCurrentLiability",
  "provision",
  "dutiesTaxes",
];

type PlHead =
  | "sales"
  | "salesReturn"
  | "purchases"
  | "purchaseReturn"
  | "direct"
  | "indirect"
  | "discountAllowed"
  | "discountReceived"
  | "otherIncome";
type EquityHead = "opening" | "adjustments" | "capital" | "drawings";
type Cls =
  | { kind: "party" }
  | { kind: "cashBank" }
  | { kind: "gst" }
  | { kind: "ledger"; group: BsGroup }
  | { kind: "suspense" }
  | { kind: "pl"; head: PlHead }
  | { kind: "equity"; head: EquityHead };

export interface FinInput {
  books: Books;
  stock: StockData;
  parties: Party[];
  banks: BankAccount[];
  accounts: BsAccount[];
  config?: FinConfig;
}

function classifier(accounts: BsAccount[], config?: FinConfig) {
  const byName = new Map(accounts.map((a) => [normalizeLedger(a.name), a] as const));
  const ledgerCls = (norm: string): Cls => {
    const a = byName.get(norm);
    if (!a) return { kind: "suspense" };
    if (a.group === "capital") return { kind: "equity", head: "capital" };
    if (a.group === "drawings") return { kind: "equity", head: "drawings" };
    if (a.group === "otherIncome") return { kind: "pl", head: "otherIncome" };
    if (a.group === "indirectExpense") return { kind: "pl", head: "indirect" };
    if (a.group === "directExpense") return { kind: "pl", head: "direct" };
    return { kind: "ledger", group: a.group };
  };
  const expenseCls = (category: string): Cls => {
    const c: ExpenseClass | undefined = config?.expenseClass?.[category];
    if (!c || c === "indirect") return { kind: "pl", head: "indirect" };
    if (c === "direct") return { kind: "pl", head: "direct" };
    if (c === "drawings") return { kind: "equity", head: "drawings" };
    return ledgerCls(normalizeLedger(c.slice("account:".length)));
  };
  return (account: string): Cls => {
    if (account.startsWith("party:")) return { kind: "party" };
    if (account === ACC.cash || account.startsWith("bank:") || account === ACC.transfer)
      return { kind: "cashBank" };
    if (account === ACC.gstOutput || account === ACC.gstInput) return { kind: "gst" };
    if (account === ACC.sales) return { kind: "pl", head: "sales" };
    if (account === ACC.salesReturn) return { kind: "pl", head: "salesReturn" };
    if (account === ACC.purchases) return { kind: "pl", head: "purchases" };
    if (account === ACC.purchaseReturn) return { kind: "pl", head: "purchaseReturn" };
    if (account === ACC.discountAllowed) return { kind: "pl", head: "discountAllowed" };
    if (account === ACC.discountReceived) return { kind: "pl", head: "discountReceived" };
    if (account === ACC.capitalOpening) return { kind: "equity", head: "opening" };
    if (account === ACC.capitalAdjustments) return { kind: "equity", head: "adjustments" };
    if (account.startsWith("expense:")) return expenseCls(account.slice("expense:".length));
    if (account.startsWith("ledger:")) return ledgerCls(account.slice("ledger:".length));
    return { kind: "suspense" };
  };
}

/** Readable names for the accounts the books themselves create. */
const FIXED_LABEL: Record<string, string> = {
  [ACC.sales]: "Sales",
  [ACC.salesReturn]: "Sales returns",
  [ACC.purchases]: "Purchases",
  [ACC.purchaseReturn]: "Purchase returns",
  [ACC.gstOutput]: "GST collected on sales (output)",
  [ACC.gstInput]: "GST paid on purchases (input)",
  [ACC.discountAllowed]: "Discount allowed",
  [ACC.discountReceived]: "Discount received",
  [ACC.capitalAdjustments]: "Capital — cash/bank adjustments",
  [ACC.capitalOpening]: "Capital — opening balances",
};

/* ── Output shapes (all amounts in RUPEES, rounded to paise) ─────────── */

export interface Line {
  label: string;
  amount: number;
  /** Indented sub-line, shown inside its heading. */
  sub?: boolean;
  /** Account key, when the line is one ledger (for drill-down). */
  account?: string;
}
export interface Section {
  title: string;
  lines: Line[];
  total: number;
}

export interface CapitalAccount {
  opening: number;
  introduced: number;
  adjustments: number;
  netProfit: number;
  drawings: number;
  closing: number;
}

export interface TrialRow {
  account: string;
  label: string;
  debit: number;
  credit: number;
}

export interface AgedParty {
  partyId: string;
  name: string;
  amount: number;
  overOneYear: number;
}

export interface FixedAssetRow {
  account: string;
  name: string;
  rate: number;
  opening: number;
  additions: number;
  deductions: number;
  depreciation: number;
  closing: number;
}

export interface QtyRow {
  itemId: string;
  name: string;
  unit: string;
  kind: ItemKind;
  opening: number;
  purchased: number;
  produced: number;
  consumed: number;
  sold: number;
  returnedIn: number;
  returnedOut: number;
  adjusted: number;
  closing: number;
}

export interface Financials {
  from: string;
  to: string;
  /** Trading account */
  openingStock: number;
  openingStockByKind: Record<ItemKind, number>;
  purchases: number;
  purchaseReturns: number;
  directExpenses: Line[];
  sales: number;
  salesReturns: number;
  closingStock: number;
  closingStockByKind: Record<ItemKind, number>;
  grossProfit: number;
  /** Profit & loss account */
  indirectExpenses: Line[];
  discountAllowed: number;
  discountReceived: number;
  otherIncome: Line[];
  netProfit: number;
  capital: CapitalAccount;
  /** Balance sheet at `to` */
  debtors: AgedParty[];
  creditors: AgedParty[];
  advancesFromCustomers: AgedParty[];
  advancesToSuppliers: AgedParty[];
  cashBank: Line[];
  bankOverdraft: Line[];
  gstPayable: number;
  gstCredit: number;
  ledgers: Record<BsGroup, Line[]>;
  suspenseDr: Line[];
  suspenseCr: Line[];
  totalAssets: number;
  totalLiabilities: number;
  /** Assets − liabilities − closing capital. Zero unless something is wrong. */
  difference: number;
  trial: TrialRow[];
  fixedAssets: FixedAssetRow[];
  stockAtClose: StockSnapshot;
  quantities: QtyRow[];
}

const sumLines = (lines: Line[]) => Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
const R = (p: number) => p / 100;

/** The register's opening balances, as postings dated before everything. */
export function registerOpenings(accounts: BsAccount[]): Posting[] {
  const out: Posting[] = [];
  for (const a of accounts) {
    if (a.group === "capital" || a.group === "drawings") continue;
    const amt = paise(a.openingBalance) * (a.openingSide === "cr" ? -1 : 1);
    if (!amt) continue;
    const doc: DocRef = { kind: "opening", id: a.id, label: `Opening — ${a.name}` };
    out.push({ date: "", account: ACC.ledger(a.name), amount: amt, doc });
    out.push({ date: "", account: ACC.capitalOpening, amount: -amt, doc });
  }
  return out;
}

export function buildFinancials(input: FinInput, from: string, to: string): Financials {
  const { books, parties, accounts } = input;
  const classify = classifier(accounts, input.config);
  const postings = [...books.postings, ...registerOpenings(accounts)];
  const names = new Map(books.names);
  for (const a of accounts) names.set(ACC.ledger(a.name), a.name);
  const labelOf = (account: string) => {
    if (names.has(account)) return names.get(account)!;
    if (FIXED_LABEL[account]) return FIXED_LABEL[account];
    if (account === ACC.cash) return "Cash in hand";
    if (account === ACC.bankUnassigned) return "Bank — UPI/cheque not linked to an account";
    if (account === ACC.transfer) return "Transfers in transit (cash ↔ bank)";
    if (account.startsWith("bank:")) return "Bank account (deleted)";
    if (account.startsWith("party:")) return "Party (deleted)";
    if (account.startsWith("expense:")) return account.slice("expense:".length);
    if (account.startsWith("suspense:"))
      return SUSPENSE_LABEL[account.slice("suspense:".length)] ?? account.slice("suspense:".length);
    if (account.startsWith("ledger:")) return account.slice("ledger:".length);
    return account;
  };

  const D0 = dayBefore(from);
  const [stock0, stock1] = stockSnapshots(input.stock, [D0, to]);
  const bal0 = balances(postings, D0);
  const bal1 = balances(postings, to);
  const period = balances(postings, to, D0);

  const isBs = (c: Cls) => c.kind !== "pl" && c.kind !== "equity";
  const netAssets = (bal: Map<string, number>, stockTotal: number) => {
    let n = paise(stockTotal);
    for (const [acc, v] of bal) if (isBs(classify(acc))) n += v;
    return n;
  };

  /* ── Trading and P&L from the period's movements ──────────────────── */
  let sales = 0,
    salesReturns = 0,
    purchases = 0,
    purchaseReturns = 0,
    discountAllowed = 0,
    discountReceived = 0;
  const direct: Line[] = [];
  const indirect: Line[] = [];
  const otherIncome: Line[] = [];
  let introduced = 0,
    adjustments = 0,
    drawings = 0;
  for (const [acc, v] of period) {
    const c = classify(acc);
    if (c.kind === "pl") {
      if (c.head === "sales") sales -= v;
      else if (c.head === "salesReturn") salesReturns += v;
      else if (c.head === "purchases") purchases += v;
      else if (c.head === "purchaseReturn") purchaseReturns -= v;
      else if (c.head === "discountAllowed") discountAllowed += v;
      else if (c.head === "discountReceived") discountReceived -= v;
      else if (c.head === "direct")
        direct.push({ label: labelOf(acc), amount: R(v), account: acc });
      else if (c.head === "indirect")
        indirect.push({ label: labelOf(acc), amount: R(v), account: acc });
      else otherIncome.push({ label: labelOf(acc), amount: R(-v), account: acc });
    } else if (c.kind === "equity") {
      if (c.head === "drawings") drawings += v;
      else if (c.head === "adjustments") adjustments -= v;
      else introduced -= v; // capital ledgers (and, defensively, any opening posting)
    }
  }
  const byLabel = (a: Line, b: Line) => a.label.localeCompare(b.label);
  direct.sort(byLabel);
  indirect.sort(byLabel);
  otherIncome.sort(byLabel);

  const openingStockP = paise(stock0.total);
  const closingStockP = paise(stock1.total);
  const directP = direct.reduce((s, l) => s + paise(l.amount), 0);
  const grossP =
    sales - salesReturns + closingStockP - openingStockP - (purchases - purchaseReturns) - directP;
  const indirectP = indirect.reduce((s, l) => s + paise(l.amount), 0);
  const otherP = otherIncome.reduce((s, l) => s + paise(l.amount), 0);
  const netP = grossP - indirectP - discountAllowed + discountReceived + otherP;

  const openingCapitalP = netAssets(bal0, stock0.total);
  const closingCapitalP = openingCapitalP + netP + introduced + adjustments - drawings;

  /* ── Balance sheet at `to` ─────────────────────────────────────────── */
  const partyById = new Map(parties.map((p) => [p.id, p] as const));
  const debtors: AgedParty[] = [];
  const creditors: AgedParty[] = [];
  const advFrom: AgedParty[] = [];
  const advTo: AgedParty[] = [];
  const cashBank: Line[] = [];
  const overdraft: Line[] = [];
  const ledgers = Object.fromEntries(
    (Object.keys(BS_GROUP_LABEL) as BsGroup[]).map((g) => [g, [] as Line[]]),
  ) as Record<BsGroup, Line[]>;
  const suspenseDr: Line[] = [];
  const suspenseCr: Line[] = [];
  let gstNet = 0;

  // Party postings by party, for ageing.
  const partyPostings = new Map<string, Posting[]>();
  for (const p of postings) {
    if (!p.account.startsWith("party:") || p.date > to) continue;
    const list = partyPostings.get(p.account) ?? [];
    list.push(p);
    partyPostings.set(p.account, list);
  }
  const aged = (acc: string, amount: number): AgedParty => {
    // FIFO: what is still owed is the NEWEST bills; anything beyond them in
    // age is the part older than a year.
    const sign = amount > 0 ? 1 : -1;
    let left = Math.abs(amount);
    let old = 0;
    const charges = (partyPostings.get(acc) ?? [])
      .filter((p) => Math.sign(p.amount) === sign)
      .sort((a, b) => b.date.localeCompare(a.date));
    for (const p of charges) {
      if (left <= 0) break;
      const take = Math.min(left, Math.abs(p.amount));
      if (p.date === "" || daysBetween(p.date, to) > 365) old += take;
      left -= take;
    }
    old += left; // nothing left to explain it but the opening balance
    return {
      partyId: acc.slice("party:".length),
      name: labelOf(acc),
      amount: R(Math.abs(amount)),
      overOneYear: R(old),
    };
  };

  for (const [acc, v] of bal1) {
    if (!v) continue;
    const c = classify(acc);
    if (c.kind === "party") {
      const type = partyById.get(acc.slice("party:".length))?.type;
      if (v > 0) (type === "supplier" ? advTo : debtors).push(aged(acc, v));
      else (type === "customer" ? advFrom : creditors).push(aged(acc, v));
    } else if (c.kind === "cashBank") {
      if (acc.startsWith("bank:") && acc !== ACC.bankUnassigned && v < 0)
        overdraft.push({ label: `${labelOf(acc)} (overdraft)`, amount: R(-v), account: acc });
      else cashBank.push({ label: labelOf(acc), amount: R(v), account: acc });
    } else if (c.kind === "gst") {
      gstNet += v;
    } else if (c.kind === "ledger") {
      const asset = ASSET_GROUPS.includes(c.group);
      ledgers[c.group].push({ label: labelOf(acc), amount: R(asset ? v : -v), account: acc });
    } else if (c.kind === "suspense") {
      if (v > 0) suspenseDr.push({ label: labelOf(acc), amount: R(v), account: acc });
      else suspenseCr.push({ label: labelOf(acc), amount: R(-v), account: acc });
    }
  }
  for (const list of [debtors, creditors, advFrom, advTo])
    list.sort((a, b) => a.name.localeCompare(b.name));
  cashBank.sort((a, b) =>
    a.account === ACC.cash ? -1 : b.account === ACC.cash ? 1 : a.label.localeCompare(b.label),
  );

  const gstPayable = gstNet < 0 ? R(-gstNet) : 0;
  const gstCredit = gstNet > 0 ? R(gstNet) : 0;

  const sumAged = (l: AgedParty[]) => l.reduce((s, x) => s + paise(x.amount), 0);
  const sumL = (l: Line[]) => l.reduce((s, x) => s + paise(x.amount), 0);
  const assetsP =
    closingStockP +
    sumAged(debtors) +
    sumAged(advTo) +
    sumL(cashBank) +
    paise(gstCredit) +
    ASSET_GROUPS.reduce((s, g) => s + sumL(ledgers[g]), 0) +
    sumL(suspenseDr);
  const liabilitiesP =
    sumAged(creditors) +
    sumAged(advFrom) +
    sumL(overdraft) +
    paise(gstPayable) +
    LIABILITY_GROUPS.reduce((s, g) => s + sumL(ledgers[g]), 0) +
    sumL(suspenseCr);

  /* ── Trial balance (closing for balance-sheet accounts, the period for
        income/expense, the capital brought forward and opening stock) ── */
  const trial: TrialRow[] = [];
  const pushTrial = (account: string, label: string, v: number) => {
    if (!v) return;
    trial.push({ account, label, debit: v > 0 ? R(v) : 0, credit: v < 0 ? R(-v) : 0 });
  };
  for (const [acc, v] of bal1) if (isBs(classify(acc))) pushTrial(acc, labelOf(acc), v);
  for (const [acc, v] of period) {
    const c = classify(acc);
    if (c.kind === "pl" || c.kind === "equity") pushTrial(acc, labelOf(acc), v);
  }
  pushTrial("capital:brought-forward", "Capital brought forward", -openingCapitalP);
  pushTrial("stock:opening", "Opening stock", openingStockP);
  trial.sort((a, b) => a.label.localeCompare(b.label));

  /* ── Fixed-asset schedule ──────────────────────────────────────────── */
  const depDocs = new Set(
    postings
      .filter((p) => {
        if (!p.account.startsWith("ledger:")) return false;
        const a = accounts.find((x) => normalizeLedger(x.name) === p.account.slice(7));
        return (
          p.amount > 0 &&
          ((a &&
            (a.group === "indirectExpense" || a.group === "directExpense") &&
            /depreciat/i.test(a.name)) ||
            /depreciat/i.test(p.account))
        );
      })
      .map((p) => `${p.doc.kind}:${p.doc.id}`),
  );
  const fixedAssets: FixedAssetRow[] = accounts
    .filter((a) => a.group === "fixedAsset")
    .map((a) => {
      const acc = ACC.ledger(a.name);
      let additions = 0,
        deductions = 0,
        dep = 0;
      for (const p of postings) {
        if (p.account !== acc || p.date === "" || p.date <= D0 || p.date > to) continue;
        if (p.amount > 0) additions += p.amount;
        else if (depDocs.has(`${p.doc.kind}:${p.doc.id}`)) dep -= p.amount;
        else deductions -= p.amount;
      }
      return {
        account: acc,
        name: a.name,
        rate: a.depreciationRate ?? 0,
        opening: R(bal0.get(acc) ?? 0),
        additions: R(additions),
        deductions: R(deductions),
        depreciation: R(dep),
        closing: R(bal1.get(acc) ?? 0),
      };
    });

  return {
    from,
    to,
    openingStock: R(openingStockP),
    openingStockByKind: stock0.byKind,
    purchases: R(purchases),
    purchaseReturns: R(purchaseReturns),
    directExpenses: direct,
    sales: R(sales),
    salesReturns: R(salesReturns),
    closingStock: R(closingStockP),
    closingStockByKind: stock1.byKind,
    grossProfit: R(grossP),
    indirectExpenses: indirect,
    discountAllowed: R(discountAllowed),
    discountReceived: R(discountReceived),
    otherIncome,
    netProfit: R(netP),
    capital: {
      opening: R(openingCapitalP),
      introduced: R(introduced),
      adjustments: R(adjustments),
      netProfit: R(netP),
      drawings: R(drawings),
      closing: R(closingCapitalP),
    },
    debtors,
    creditors,
    advancesFromCustomers: advFrom,
    advancesToSuppliers: advTo,
    cashBank,
    bankOverdraft: overdraft,
    gstPayable,
    gstCredit,
    ledgers,
    suspenseDr,
    suspenseCr,
    totalAssets: R(assetsP),
    totalLiabilities: R(liabilitiesP),
    difference: R(assetsP - liabilitiesP - closingCapitalP),
    trial,
    fixedAssets,
    stockAtClose: stock1,
    quantities: quantityDetails(input.stock, stock0, stock1, from, to),
  };
}

/** Opening → purchased/produced/… → closing, per item, for the period. */
function quantityDetails(
  data: StockData,
  s0: StockSnapshot,
  s1: StockSnapshot,
  from: string,
  to: string,
): QtyRow[] {
  const inPeriod = (d: string) => d >= from && d <= to;
  const rows = new Map<string, QtyRow>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) {
      const it = data.items.find((i) => i.id === id);
      r = {
        itemId: id,
        name: it?.name ?? "(deleted item)",
        unit: it?.unit ?? "",
        kind: it?.kind ?? "trading",
        opening: 0,
        purchased: 0,
        produced: 0,
        consumed: 0,
        sold: 0,
        returnedIn: 0,
        returnedOut: 0,
        adjusted: 0,
        closing: 0,
      };
      rows.set(id, r);
    }
    return r;
  };
  const r2 = (n: number) => Math.round(n * 100) / 100;
  for (const p of s0.items) row(p.itemId).opening = p.qty;
  for (const p of s1.items) row(p.itemId).closing = p.qty;
  for (const inv of data.purchases)
    if (inPeriod(inv.date)) for (const l of inv.lineItems) row(l.itemId).purchased += l.qty || 0;
  for (const inv of data.sales)
    if (inPeriod(inv.date)) for (const l of inv.lineItems) row(l.itemId).sold += l.qty || 0;
  for (const r of data.saleReturns)
    if (inPeriod(r.date) && !r.isAdjustmentOnly)
      for (const l of r.lineItems) row(l.itemId).returnedIn += l.qty || 0;
  for (const r of data.purchaseReturns)
    if (inPeriod(r.date) && !r.isAdjustmentOnly)
      for (const l of r.lineItems) row(l.itemId).returnedOut += l.qty || 0;
  for (const a of data.stockAdjustments)
    if (inPeriod(a.date)) row(a.itemId).adjusted += (a.type === "add" ? 1 : -1) * (a.qty || 0);
  for (const p of data.productions) {
    if (!inPeriod(p.date)) continue;
    row(p.finishedItemId).produced += p.qty || 0;
    for (const c of p.components ?? []) row(c.itemId).consumed += c.qty || 0;
  }
  return [...rows.values()]
    .map((r) => ({
      ...r,
      purchased: r2(r.purchased),
      produced: r2(r.produced),
      consumed: r2(r.consumed),
      sold: r2(r.sold),
      returnedIn: r2(r.returnedIn),
      returnedOut: r2(r.returnedOut),
      adjusted: r2(r.adjusted),
    }))
    .filter(
      (r) =>
        r.opening || r.closing || r.purchased || r.produced || r.consumed || r.sold || r.adjusted,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Income-tax WDV depreciation for one fixed asset for the financial year
 * [from, to] — the figure the "Post depreciation" helper offers.
 * Full rate on the opening written-down value and on additions put to use
 * for 180 days or more in the year; half rate on later additions;
 * deductions (sale proceeds credited to the asset) reduce the block first.
 */
export function wdvDepreciation(
  account: Pick<BsAccount, "name" | "depreciationRate">,
  postings: Posting[],
  from: string,
  to: string,
): { base: number; halfBase: number; depreciation: number } {
  const acc = ACC.ledger(account.name);
  const rate = (account.depreciationRate ?? 0) / 100;
  const D0 = dayBefore(from);
  let opening = 0,
    full = 0,
    half = 0,
    deductions = 0;
  for (const p of postings) {
    if (p.account !== acc) continue;
    if (p.date === "" || p.date <= D0) opening += p.amount;
    else if (p.date <= to) {
      if (p.amount > 0) {
        if (daysBetween(p.date, to) + 1 >= 180) full += p.amount;
        else half += p.amount;
      } else if (!/depreciat/i.test(p.doc.label)) deductions -= p.amount;
    }
  }
  let base = opening + full - deductions;
  let halfBase = half;
  if (base < 0) {
    halfBase = Math.max(0, halfBase + base);
    base = 0;
  }
  const dep = Math.round(base * rate + halfBase * (rate / 2));
  return { base: R(base), halfBase: R(halfBase), depreciation: R(Math.max(0, dep)) };
}

export { sumLines };
