/**
 * The double-entry view of the books.
 *
 * This app stores documents (bills, payments, expenses…), not ledgers: every
 * balance on every screen is derived from them. A balance sheet needs the
 * ledgers. So every document is turned here into POSTINGS — signed amounts
 * against named accounts (+ debit, − credit) — and every document's postings
 * add up to exactly zero. A trial balance, the profit and loss and the
 * balance sheet are then just sums of these, which is what makes them
 * balance by construction rather than by hope.
 *
 * Each posting mirrors what the existing screens already say about the same
 * document, so the books and the screens cannot disagree:
 *  - a party is credited at billing with what the bill took on the day
 *    (`paid` less everything that settled it later — Payments and Journal
 *    Vouchers), exactly as the party statement shows it;
 *  - money lands wherever `splitsOf` says it did, exactly as the Cash and
 *    Bank screens read it;
 *  - GST is the STORED `taxAmount`, exactly what the Profit & Loss strips.
 * Where a document disagrees with itself (old data: a bill whose money rows
 * do not cover what it says was paid, a payment with no mode), the
 * difference goes to a named SUSPENSE account with the document listed, never
 * silently into a total.
 *
 * Amounts are integer paise throughout, so a balance is exactly zero or it is
 * not — no float dust to forgive.
 *
 * Stock is not posted: the statements use the periodic method (opening stock
 * + purchases − closing stock), with both stock figures from
 * lib/stockValuation.ts.
 */
import type {
  BankAccount,
  BankTxn,
  CashAdjustment,
  Expense,
  Invoice,
  JournalVoucher,
  Party,
  Payment,
  PaymentSplit,
  Return,
} from "@/types";
import { splitsOf, NEEDS_ACCOUNT } from "@/lib/paymentSplit";
import { settledAfterBilling } from "@/lib/ledger";

/** Rupees → integer paise. */
export const paise = (rupees: unknown): number => {
  const n = typeof rupees === "number" ? rupees : Number(rupees);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
/** Integer paise → rupees. */
export const rupees = (p: number): number => p / 100;

export type DocKind =
  | "opening"
  | "sale"
  | "purchase"
  | "sale-return"
  | "purchase-return"
  | "payment"
  | "expense"
  | "cash-adjustment"
  | "bank-txn"
  | "journal";

export interface DocRef {
  kind: DocKind;
  id: string;
  label: string;
}

export interface Posting {
  /** YYYY-MM-DD; "" for an opening balance (before every date). */
  date: string;
  account: string;
  /** Integer paise, + debit / − credit. */
  amount: number;
  doc: DocRef;
}

/** Why a document had to post to suspense — shown on the Checks screen. */
export interface SuspenseNote {
  account: string;
  amount: number;
  doc: DocRef;
  date: string;
  why: string;
}

export interface BooksData {
  parties: Party[];
  banks: BankAccount[];
  sales: Invoice[];
  purchases: Invoice[];
  saleReturns: Return[];
  purchaseReturns: Return[];
  payments: Payment[];
  expenses: Expense[];
  cashAdjustments: CashAdjustment[];
  bankTxns: BankTxn[];
  journalVouchers: JournalVoucher[];
}

/** Account keys. Kept as plain strings so a ledger can be named by data
 *  (a party id, a bank id, an expense category, a JV ledger name). */
export const ACC = {
  cash: "cash",
  bankUnassigned: "bank:unassigned",
  transfer: "transfer",
  sales: "sales",
  salesReturn: "sales-return",
  purchases: "purchases",
  purchaseReturn: "purchase-return",
  gstOutput: "gst:output",
  gstInput: "gst:input",
  discountAllowed: "discount:allowed",
  discountReceived: "discount:received",
  capitalAdjustments: "capital:adjustments",
  capitalOpening: "capital:opening",
  party: (id: string) => `party:${id}`,
  bank: (id: string) => `bank:${id}`,
  expense: (category: string) => `expense:${category.trim() || "Uncategorised"}`,
  ledger: (name: string) => `ledger:${normalizeLedger(name)}`,
  suspense: (code: string) => `suspense:${code}`,
};

/** JV ledger names are typed by hand — "Capital", "capital ", "CAPITAL" are
 *  one account. */
export function normalizeLedger(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export const SUSPENSE_LABEL: Record<string, string> = {
  "bill-settlement": "Bills whose payment rows don't match what they say was paid",
  "payment-money": "Payments recorded without a cash/bank mode",
  "expense-unpaid": "Expenses recorded without a cash/bank mode (outstanding)",
  "jv-unbalanced": "Journal vouchers whose debits ≠ credits",
  "bank-transfer-type": "Bank entries of the old 'transfer' type (not counted anywhere)",
};

function moneyAccount(s: PaymentSplit): string {
  if (s.mode === "cash") return ACC.cash;
  if (s.bankId) return ACC.bank(s.bankId);
  return NEEDS_ACCOUNT.includes(s.mode) ? ACC.bankUnassigned : ACC.cash;
}

/** Signed money rows of a document: account → paise. */
function moneyRows(doc: Parameters<typeof splitsOf>[0], settled = 0): [string, number][] {
  return splitsOf(doc, settled).map((s) => [moneyAccount(s), paise(s.amount)] as [string, number]);
}

const taxOf = (d: { taxAmount?: number; gstEnabled?: boolean }) =>
  d.gstEnabled === false ? 0 : paise(d.taxAmount);
const dirOf = (r: Return) => (r.direction === "increase" ? -1 : 1);

export interface Books {
  postings: Posting[];
  suspense: SuspenseNote[];
  /** Display names for accounts whose key is an id or a normalized name. */
  names: Map<string, string>;
}

export function buildPostings(data: BooksData): Books {
  const postings: Posting[] = [];
  const suspense: SuspenseNote[] = [];
  const names = new Map<string, string>();

  const post = (date: string, doc: DocRef, lines: [string, number][]) => {
    for (const [account, amount] of lines) {
      if (amount) postings.push({ date, account, amount, doc });
    }
  };
  const toSuspense = (date: string, doc: DocRef, code: string, amount: number, why: string) => {
    if (!amount) return;
    const account = ACC.suspense(code);
    postings.push({ date, account, amount, doc });
    suspense.push({ account, amount, doc, date, why });
  };

  for (const p of data.parties) names.set(ACC.party(p.id), p.name);
  for (const b of data.banks) names.set(ACC.bank(b.id), b.name);

  /* ── Opening balances — before every date ─────────────────────────── */
  for (const p of data.parties) {
    const ob = paise(p.openingBalance);
    if (ob)
      post("", { kind: "opening", id: p.id, label: `Opening — ${p.name}` }, [
        [ACC.party(p.id), ob],
        [ACC.capitalOpening, -ob],
      ]);
  }
  for (const b of data.banks) {
    const ob = paise(b.openingBalance);
    if (ob)
      post("", { kind: "opening", id: b.id, label: `Opening — ${b.name}` }, [
        [ACC.bank(b.id), ob],
        [ACC.capitalOpening, -ob],
      ]);
  }

  const settled = settledAfterBilling(
    [...data.sales, ...data.purchases],
    data.payments,
    data.journalVouchers,
  );

  /* ── Sales and purchases ─────────────────────────────────────────────── */
  for (const s of data.sales) {
    const doc: DocRef = { kind: "sale", id: s.id, label: `Sale ${s.number} — ${s.partyName}` };
    names.set(ACC.party(s.partyId), names.get(ACC.party(s.partyId)) ?? s.partyName);
    const T = paise(s.total);
    const X = taxOf(s);
    const later = settled.get(s.id) ?? 0;
    const direct = paise(Math.max(0, (s.paid || 0) - later));
    const money = moneyRows(s, later);
    const moneySum = money.reduce((n, [, a]) => n + a, 0);
    post(s.date, doc, [
      [ACC.party(s.partyId), T],
      [ACC.sales, -(T - X)],
      [ACC.gstOutput, -X],
      ...money,
      [ACC.party(s.partyId), -direct],
    ]);
    toSuspense(
      s.date,
      doc,
      "bill-settlement",
      direct - moneySum,
      "Paid at billing but no matching cash/bank row",
    );
  }
  for (const p of data.purchases) {
    const doc: DocRef = {
      kind: "purchase",
      id: p.id,
      label: `Purchase ${p.number} — ${p.partyName}`,
    };
    names.set(ACC.party(p.partyId), names.get(ACC.party(p.partyId)) ?? p.partyName);
    const T = paise(p.total);
    const X = taxOf(p);
    const later = settled.get(p.id) ?? 0;
    const direct = paise(Math.max(0, (p.paid || 0) - later));
    const money = moneyRows(p, later);
    const moneySum = money.reduce((n, [, a]) => n + a, 0);
    post(p.date, doc, [
      [ACC.party(p.partyId), -T],
      [ACC.purchases, T - X],
      [ACC.gstInput, X],
      ...money.map(([a, v]) => [a, -v] as [string, number]),
      [ACC.party(p.partyId), direct],
    ]);
    toSuspense(
      p.date,
      doc,
      "bill-settlement",
      moneySum - direct,
      "Paid at billing but no matching cash/bank row",
    );
  }

  /* ── Returns (credit / debit notes) ─────────────────────────────────── */
  for (const r of data.saleReturns) {
    const doc: DocRef = {
      kind: "sale-return",
      id: r.id,
      label: `Sale return ${r.number} — ${r.partyName}`,
    };
    const d = dirOf(r);
    const T = paise(r.total) * d;
    const X = taxOf(r) * d;
    post(r.date, doc, [
      [ACC.party(r.partyId), -T],
      [ACC.salesReturn, T - X],
      [ACC.gstOutput, X],
    ]);
  }
  for (const r of data.purchaseReturns) {
    const doc: DocRef = {
      kind: "purchase-return",
      id: r.id,
      label: `Purchase return ${r.number} — ${r.partyName}`,
    };
    const d = dirOf(r);
    const T = paise(r.total) * d;
    const X = taxOf(r) * d;
    post(r.date, doc, [
      [ACC.party(r.partyId), T],
      [ACC.purchaseReturn, -(T - X)],
      [ACC.gstInput, -X],
    ]);
  }

  /* ── Payments in / out, with settlement discounts ──────────────────── */
  for (const p of data.payments) {
    const doc: DocRef = {
      kind: "payment",
      id: p.id,
      label: `Payment ${p.type === "in" ? "from" : "to"} ${p.partyName}`,
    };
    names.set(ACC.party(p.partyId), names.get(ACC.party(p.partyId)) ?? p.partyName);
    const A = paise(p.amount);
    const D = (p.allocations ?? []).reduce((n, a) => n + paise(a.discount), 0);
    const money = moneyRows(p);
    const moneySum = money.reduce((n, [, a]) => n + a, 0);
    const party = ACC.party(p.partyId);
    if (p.type === "in") {
      post(p.date, doc, [...money, [party, -A], [ACC.discountAllowed, D], [party, -D]]);
      toSuspense(p.date, doc, "payment-money", A - moneySum, "Received with no cash/bank mode");
    } else {
      post(p.date, doc, [
        ...money.map(([a, v]) => [a, -v] as [string, number]),
        [party, A],
        [party, D],
        [ACC.discountReceived, -D],
      ]);
      toSuspense(p.date, doc, "payment-money", moneySum - A, "Paid with no cash/bank mode");
    }
  }

  /* ── Expenses ───────────────────────────────────────────────────────── */
  for (const e of data.expenses) {
    const doc: DocRef = {
      kind: "expense",
      id: e.id,
      label: `Expense — ${e.category}${e.payeeName ? `, ${e.payeeName}` : ""}`,
    };
    const E = paise(e.amount);
    const money = moneyRows(e);
    const moneySum = money.reduce((n, [, a]) => n + a, 0);
    post(e.date, doc, [
      [ACC.expense(e.category), E],
      ...money.map(([a, v]) => [a, -v] as [string, number]),
    ]);
    toSuspense(e.date, doc, "expense-unpaid", moneySum - E, "Expense with no cash/bank mode");
  }

  /* ── Cash and bank movements that are not a bill or payment ─────────── */
  for (const a of data.cashAdjustments) {
    const doc: DocRef = {
      kind: "cash-adjustment",
      id: a.id,
      label: `Cash ${a.type === "add" ? "added" : "reduced"}${a.reason ? ` — ${a.reason}` : ""}`,
    };
    const amt = paise(a.amount) * (a.type === "add" ? 1 : -1);
    // A transfer leg posts against the transfer clearing account, which its
    // other leg (a BankTxn) clears. Anything else is the owner's own money
    // coming in or going out of the drawer.
    const other = a.transferId ? ACC.transfer : ACC.capitalAdjustments;
    post(a.date, doc, [
      [ACC.cash, amt],
      [other, -amt],
    ]);
  }
  for (const t of data.bankTxns) {
    const doc: DocRef = {
      kind: "bank-txn",
      id: t.id,
      label: `Bank ${t.type}${t.notes ? ` — ${t.notes}` : ""}`,
    };
    if (t.type !== "deposit" && t.type !== "withdraw") {
      // The bank ledger ignores this legacy type entirely, so the books do
      // too — but it is listed, because it may be money nobody counted.
      suspense.push({
        account: ACC.suspense("bank-transfer-type"),
        amount: 0,
        doc,
        date: t.date,
        why: "Old 'transfer'-type bank entry — not counted",
      });
      continue;
    }
    const amt = paise(t.amount) * (t.type === "deposit" ? 1 : -1);
    const other = t.transferId ? ACC.transfer : ACC.capitalAdjustments;
    post(t.date, doc, [
      [ACC.bank(t.bankId), amt],
      [other, -amt],
    ]);
  }

  /* ── Journal vouchers ───────────────────────────────────────────────── */
  for (const jv of data.journalVouchers) {
    const doc: DocRef = { kind: "journal", id: jv.id, label: `JV ${jv.number} — ${jv.narration}` };
    const lines: [string, number][] = [];
    for (const l of jv.lines) {
      const amt = paise(l.debit) - paise(l.credit);
      if (!amt) continue;
      let account: string;
      if (l.kind === "party") account = ACC.party(l.refId ?? "");
      else if (l.kind === "bank") account = ACC.bank(l.refId ?? "");
      else if (l.kind === "cash") account = ACC.cash;
      else if (l.kind === "expense") account = ACC.expense(l.refId || l.refName);
      else {
        account = ACC.ledger(l.refName || l.refId || "");
        if (!names.has(account)) names.set(account, (l.refName || l.refId || "").trim());
      }
      lines.push([account, amt]);
    }
    post(jv.date, doc, lines);
    const off = lines.reduce((n, [, a]) => n + a, 0);
    toSuspense(jv.date, doc, "jv-unbalanced", -off, "Debits and credits differ");
  }

  return { postings, suspense, names };
}

/**
 * Balance of every account from postings dated on or before `asOf` (and
 * after `after`, when given). Opening postings (date "") count only when no
 * lower bound is given — a period's movements never include them.
 */
export function balances(postings: Posting[], asOf: string, after?: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of postings) {
    if (p.date > asOf) continue;
    if (after !== undefined && (p.date === "" || p.date <= after)) continue;
    out.set(p.account, (out.get(p.account) ?? 0) + p.amount);
  }
  return out;
}

/** Every document's postings must sum to exactly zero. Returns the ones that
 *  do not — expected to be none; the audit suite pins it. */
export function unbalancedDocs(postings: Posting[]): { doc: DocRef; off: number }[] {
  const sums = new Map<string, { doc: DocRef; off: number }>();
  for (const p of postings) {
    const k = `${p.doc.kind}:${p.doc.id}`;
    const s = sums.get(k) ?? { doc: p.doc, off: 0 };
    s.off += p.amount;
    sums.set(k, s);
  }
  return [...sums.values()].filter((s) => s.off !== 0);
}
