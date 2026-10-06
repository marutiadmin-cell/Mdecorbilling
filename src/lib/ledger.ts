import type {
  Invoice,
  Payment,
  Return,
  Item,
  Expense,
  PaymentMode,
  CashAdjustment,
  BankTxn,
  LineItem,
  JournalVoucher,
} from "@/types";

import { splitsOf, bankParts } from "@/lib/paymentSplit";
import { stateFromGstin, supplyKind, splitTax, allocateAcrossRateBuckets } from "@/lib/gstin";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Every formula below was written when a Return could only ever DECREASE a
 * value (a Credit Note reduces a sale, a Debit Note reduces a purchase) —
 * multiplying by this flips that to an increase (the other half of GST
 * Section 34: a Debit Note that increases a sale, or a Credit Note that
 * increases a purchase) wherever a `direction: "increase"` adjustment-only
 * note needs the OPPOSITE of whatever a plain return has always done there.
 * Absent/"decrease" multiplies by 1 — every return saved before this field
 * existed behaves exactly as before.
 */
const returnDirMul = (r: Pick<Return, "direction">): 1 | -1 => (r.direction === "increase" ? -1 : 1);

/** Sum of a payment's per-invoice allocations. Legacy payments (saved before
 * allocations existed) stored the linked invoice numbers in `ref` — if every
 * comma-separated token matches a known invoice number, the whole amount
 * was applied to invoices. */
export function allocatedAmount(p: Payment, invoiceNumbers?: Set<string>): number {
  if (p.allocations && p.allocations.length) {
    // Cash only — a settlement discount is not part of the money received,
    // so it must not reduce the advance calculation below.
    return r2(p.allocations.reduce((s, a) => s + a.amount, 0));
  }
  if (p.ref && invoiceNumbers) {
    const tokens = p.ref
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length && tokens.every((t) => invoiceNumbers.has(t))) return p.amount;
  }
  return 0;
}

/** Portion of a payment NOT applied to any invoice (an advance). */
export function advanceAmount(p: Payment, invoiceNumbers?: Set<string>): number {
  return Math.max(0, r2(p.amount - allocatedAmount(p, invoiceNumbers)));
}

/**
 * invoiceId → how much of that invoice was SETTLED through Payment records.
 *
 * Settled, not received: a settlement discount closes the remaining balance
 * without cash changing hands, so it counts here (the invoice really is
 * paid off) even though it never reaches a cash or bank position. Keeping
 * the two ideas in step is what stops `modeFlows`' direct-portion formula
 * (paid − applied) from inventing phantom cash on a discounted bill.
 */
export function paidViaPayments(payments: Payment[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const p of payments) {
    for (const a of p.allocations ?? []) {
      map.set(a.invoiceId, r2((map.get(a.invoiceId) ?? 0) + a.amount + (a.discount ?? 0)));
    }
  }
  return map;
}

/** Total written off across a set of payments — "Discount Allowed" on money
 * coming in, "Discount Received" on money going out. Real profit impact:
 * the sale was booked at full value, so the waived part has to come back off
 * the bottom line. */
export function totalSettlementDiscount(payments: Payment[]): number {
  return r2(
    payments.reduce(
      (s, p) => s + (p.allocations ?? []).reduce((x, a) => x + (a.discount ?? 0), 0),
      0,
    ),
  );
}

export interface PartyBalance {
  partyId: string;
  name: string;
  invoiced: number;
  returned: number;
  /** invoice.paid totals (initial paid + amounts applied via payments) */
  settled: number;
  /** payment amounts not applied to any invoice */
  advances: number;
  /** invoiced − returned − settled − advances (positive = they owe / we owe) */
  balance: number;
}

/** Per-party outstanding balances. Pass sales + sale returns + type "in"
 * payments for customers, or purchases + purchase returns + type "out"
 * payments for suppliers. Applied payments are already inside invoice.paid,
 * so only the advance portion of each payment is subtracted separately —
 * this is what keeps the dashboard and ledger reports in agreement.
 *
 * Pass the relevant parties so a party's openingBalance is folded into the
 * result — without this, a migrated party with a non-zero opening balance
 * but no transactions yet would be invisible here even though their own
 * statement page (parties_.$id.tsx) correctly shows what they owe.
 *
 * `side` prevents double counting: parties are type "both", so one opening
 * balance must not appear in BOTH the receivable and payable totals. Sign
 * convention: positive opening = the party owes us (counts on the customer
 * side only), negative = we owe them (counts on the supplier side only).
 * Omit `side` (statement page) to use the signed value as-is. */
/**
 * Spread one payment across open bills, oldest first.
 *
 * This is what "₹20,000 off the account" has to mean: the money clears the
 * bills that have been waiting longest, and only what is left over becomes an
 * advance. Anything else — newest first, or spread evenly — leaves old bills
 * open forever and makes an ageing report meaningless.
 *
 * Cash goes on a bill first, then the discount closes whatever that bill is
 * still short. Doing it per bill in the same pass is what makes the
 * shopkeeper's usual case work in one step: a 20,500 bill, 20,000 taken and
 * 500 written off closes exactly, with no arithmetic done by hand.
 *
 * `dues` MUST already be in oldest-first order — the caller owns that, since
 * only it knows the bill dates.
 */
export function spreadFifo(
  dues: number[],
  cash: number,
  discount: number,
): { apply: number; discount: number }[] {
  let cashLeft = Math.max(0, r2(cash));
  let discLeft = Math.max(0, r2(discount));
  return dues.map((rawDue) => {
    const due = Math.max(0, r2(rawDue));
    const apply = Math.min(cashLeft, due);
    cashLeft = r2(cashLeft - apply);
    const disc = Math.min(discLeft, r2(due - apply));
    discLeft = r2(discLeft - disc);
    return { apply: r2(apply), discount: r2(disc) };
  });
}

export function partyBalances(
  invoices: Invoice[],
  returns: Return[],
  payments: Payment[],
  parties: { id: string; name: string; openingBalance?: number }[] = [],
  side?: "customer" | "supplier",
): PartyBalance[] {
  const numbers = new Set(invoices.map((i) => i.number));
  const map = new Map<string, PartyBalance>();
  const entry = (id: string, name: string): PartyBalance => {
    let e = map.get(id);
    if (!e) {
      e = { partyId: id, name, invoiced: 0, returned: 0, settled: 0, advances: 0, balance: 0 };
      map.set(id, e);
    }
    return e;
  };
  for (const p of parties) {
    entry(p.id, p.name);
  }
  for (const inv of invoices) {
    const e = entry(inv.partyId, inv.partyName);
    e.invoiced = r2(e.invoiced + (inv.total || 0));
    e.settled = r2(e.settled + (inv.paid || 0));
  }
  for (const ret of returns) {
    const e = entry(ret.partyId, ret.partyName);
    e.returned = r2(e.returned + (ret.total || 0));
  }
  for (const p of payments) {
    const e = entry(p.partyId, p.partyName);
    e.advances = r2(e.advances + advanceAmount(p, numbers));
  }
  const openingById = new Map(parties.map((p) => [p.id, p.openingBalance ?? 0]));
  for (const e of map.values()) {
    const raw = openingById.get(e.partyId) ?? 0;
    const opening =
      side === "customer" ? Math.max(0, raw) : side === "supplier" ? Math.max(0, -raw) : raw;
    e.balance = r2(opening + e.invoiced - e.returned - e.settled - e.advances);
  }
  return Array.from(map.values());
}

export interface PartyNetPosition {
  partyId: string;
  name: string;
  /** Signed. Positive = they owe you (receivable). Negative = you owe them
   * (payable). Zero = square. */
  net: number;
}

/**
 * ONE net position per party — the single source of truth for Receivable and
 * Payable.
 *
 * Why this exists: `partyBalances(..., side)` computes the customer and
 * supplier sides as two INDEPENDENT sums, assigning the opening balance to
 * whichever side its sign implies. That is fine while a party only ever
 * trades one way, but it cannot NET. A party carrying a 9,850 payable
 * opening who is then sold 11,000 of goods came out as 9,850 payable AND
 * 11,000 receivable — the same party counted twice, on both sides of the
 * dashboard, when their real position is 1,150 receivable. The party's own
 * statement always showed 1,150, because it works from one signed running
 * balance; the dashboard disagreed with it.
 *
 * So: fold everything into one signed number per party, exactly as the
 * statement does, and only then decide which side it lands on. A party can
 * now appear in Receivable or Payable, never both.
 *
 * Sign convention matches Party.openingBalance and buildPartyStatement:
 * sales and purchase returns increase what they owe you; purchases, sale
 * returns and money you've received reduce it.
 */
export function netPartyPositions(
  parties: { id: string; name: string; openingBalance?: number }[],
  data: {
    sales: Invoice[];
    purchases: Invoice[];
    saleReturns: Return[];
    purchaseReturns: Return[];
    payments: Payment[];
    /** Optional so every call site predating Journal Vouchers still compiles
     *  and behaves exactly as before — a party with no JV lines against it
     *  is completely unaffected either way. */
    journalVouchers?: JournalVoucher[];
  },
): PartyNetPosition[] {
  const map = new Map<string, PartyNetPosition>();
  const entry = (id: string, name: string) => {
    let e = map.get(id);
    if (!e) {
      e = { partyId: id, name, net: 0 };
      map.set(id, e);
    }
    return e;
  };
  for (const p of parties) entry(p.id, p.name).net = p.openingBalance ?? 0;

  const saleNumbers = new Set(data.sales.map((i) => i.number));
  const purchaseNumbers = new Set(data.purchases.map((i) => i.number));

  // They owe you more.
  for (const s of data.sales) entry(s.partyId, s.partyName).net += s.total || 0;
  for (const r of data.purchaseReturns)
    entry(r.partyId, r.partyName).net += (r.total || 0) * returnDirMul(r);
  // They owe you less.
  for (const p of data.purchases) entry(p.partyId, p.partyName).net -= p.total || 0;
  for (const r of data.saleReturns)
    entry(r.partyId, r.partyName).net -= (r.total || 0) * returnDirMul(r);

  // Money already settled ON a bill is inside invoice.paid; only the
  // unallocated (advance) part of a payment moves the balance separately —
  // the same rule partyBalances uses, so the two can't drift.
  for (const s of data.sales) entry(s.partyId, s.partyName).net -= s.paid || 0;
  for (const p of data.purchases) entry(p.partyId, p.partyName).net += p.paid || 0;
  for (const pay of data.payments) {
    const numbers = pay.type === "in" ? saleNumbers : purchaseNumbers;
    const advance = advanceAmount(pay, numbers);
    if (!advance) continue;
    entry(pay.partyId, pay.partyName).net += pay.type === "in" ? -advance : advance;
  }

  // A Journal Voucher's party line uses the exact same direction a sale
  // already does: a Debit increases what they owe (same as a sale), a
  // Credit decreases it (same as a payment received) — see JournalLine's own
  // doc comment in src/types/index.ts.
  for (const jv of data.journalVouchers ?? []) {
    for (const l of jv.lines) {
      if (l.kind !== "party" || !l.refId) continue;
      entry(l.refId, l.refName).net += l.debit - l.credit;
    }
  }

  for (const e of map.values()) e.net = r2(e.net);
  return Array.from(map.values());
}

export interface FlowEntry {
  date: string;
  type: string;
  ref: string;
  in: number;
  out: number;
  /** The record behind this row.
   *
   * Cash in hand is DERIVED — a bill paid in cash, an expense, a payment, a
   * manual adjustment. Without knowing which, the Cash page can only show
   * numbers: it cannot open the bill a row came from, and it certainly
   * cannot let anyone edit a row, because "editing the cash" of a sale means
   * editing the sale. This says which record owns the row so each one can be
   * offered the action that is actually safe for it. */
  source?: {
    kind: "sale" | "purchase" | "expense" | "payment" | "adjustment" | "journal";
    id: string;
  };
}

/** Money movement for one payment mode (cash, bank, …). Amounts settled
 * later via Payment records count under the payment's own mode, not the
 * invoice's, so nothing is counted twice. */
/**
 * What a document put through this mode WITHOUT landing it on a specific
 * bank account's stored balance.
 *
 * That second half is the whole reason these flows exist separately from the
 * bank ledger: money attributed to an account has already moved that
 * account's own `balance` field, and the Bank page and dashboard add these
 * flows ON TOP of the stored balances — so counting it here too would double
 * it.
 *
 * Reading it off the split rows rather than the document's single mode is
 * what makes a part-cash, part-bank bill possible. Before this, the sales
 * loop below said "if (s.bankId) continue" and dropped the whole bill: the
 * bank half was booked correctly by the bank ledger and the cash half
 * vanished from Cash on Hand. That does not read as a bug at the counter, it
 * reads as the till being short.
 */
function unbankedPart(
  doc: Parameters<typeof splitsOf>[0],
  mode: PaymentMode,
  settledElsewhere = 0,
): number {
  return r2(
    splitsOf(doc, settledElsewhere)
      .filter((s) => s.mode === mode && !s.bankId)
      .reduce((n, s) => n + (s.amount || 0), 0),
  );
}

export function modeFlows(
  mode: PaymentMode,
  sales: Invoice[],
  purchases: Invoice[],
  expenses: Expense[],
  payments: Payment[],
): FlowEntry[] {
  // Money allocated to an invoice AFTER it was billed belongs to the Payment
  // that brought it, which appears in these flows under its own mode.
  const applied = paidViaPayments(payments);
  const list: FlowEntry[] = [];
  for (const s of sales) {
    const direct = unbankedPart(s, mode, applied.get(s.id) ?? 0);
    if (direct > 0)
      list.push({
        date: s.date,
        type: "Sale",
        ref: `${s.number} — ${s.partyName}`,
        in: direct,
        out: 0,
        source: { kind: "sale", id: s.id },
      });
  }
  for (const s of purchases) {
    const direct = unbankedPart(s, mode, applied.get(s.id) ?? 0);
    if (direct > 0)
      list.push({
        date: s.date,
        type: "Purchase",
        ref: `${s.number} — ${s.partyName}`,
        in: 0,
        out: direct,
        source: { kind: "purchase", id: s.id },
      });
  }
  for (const e of expenses) {
    const out = unbankedPart(e, mode);
    if (out > 0)
      list.push({
        date: e.date,
        type: "Expense",
        ref: e.category,
        in: 0,
        out,
        source: { kind: "expense", id: e.id },
      });
  }
  for (const p of payments) {
    const amount = unbankedPart(p, mode);
    if (amount > 0)
      list.push({
        date: p.date,
        type: p.type === "in" ? "Payment In" : "Payment Out",
        ref: p.partyName,
        in: p.type === "in" ? amount : 0,
        out: p.type === "out" ? amount : 0,
        source: { kind: "payment", id: p.id },
      });
  }
  list.sort((a, b) => b.date.localeCompare(a.date));
  return list;
}

export const netFlow = (entries: FlowEntry[]) => r2(entries.reduce((s, e) => s + e.in - e.out, 0));

/** Cash-mode flows plus manual cash adjustments (counter corrections, drawings). */
export function cashFlows(
  sales: Invoice[],
  purchases: Invoice[],
  expenses: Expense[],
  payments: Payment[],
  adjustments: CashAdjustment[],
  /** Optional — see the same note on netPartyPositions. A JV's cash line
   *  uses the same natural "Debit = money in" direction as a CashAdjustment
   *  type "add" — no inversion, unlike bank's own passbook-style ledger. */
  journalVouchers: JournalVoucher[] = [],
): FlowEntry[] {
  const list = modeFlows("cash", sales, purchases, expenses, payments);
  for (const a of adjustments) {
    list.push({
      date: a.date,
      type: a.type === "add" ? "Cash Added" : "Cash Reduced",
      ref: a.reason || "Manual adjustment",
      in: a.type === "add" ? a.amount : 0,
      out: a.type === "reduce" ? a.amount : 0,
      source: { kind: "adjustment", id: a.id },
    });
  }
  for (const jv of journalVouchers) {
    for (const l of jv.lines) {
      if (l.kind !== "cash") continue;
      const net = r2(l.debit - l.credit);
      if (!net) continue;
      list.push({
        date: jv.date,
        type: "Journal Voucher",
        ref: `${jv.number} — ${jv.narration}`,
        in: net > 0 ? net : 0,
        out: net < 0 ? -net : 0,
        source: { kind: "journal", id: jv.id },
      });
    }
  }
  list.sort((a, b) => b.date.localeCompare(a.date));
  return list;
}

/**
 * UPI and cheques settle into the bank — group them with bank-mode flows.
 *
 * Deliberately NEVER includes Journal Vouchers (or BankTxn deposits/
 * withdrawals, which this already excludes): a JV bank line always names one
 * specific account and already moved that account's own stored `balance`
 * field at save time (see JournalVoucherRepo's save path), exactly like a
 * BankTxn does. This function is the OTHER half — money in bank/upi/cheque
 * mode not yet attributed to any specific account — so adding a JV line
 * here too would double-count it on top of the balance it already updated.
 * A JV's bank effect is visible in buildBankLedger (that specific account's
 * own passbook) and in the account's own stored balance, not here.
 */
export function bankFlows(
  sales: Invoice[],
  purchases: Invoice[],
  expenses: Expense[],
  payments: Payment[],
): FlowEntry[] {
  const modes: PaymentMode[] = ["bank", "upi", "cheque"];
  const list = modes.flatMap((m) => modeFlows(m, sales, purchases, expenses, payments));
  list.sort((a, b) => b.date.localeCompare(a.date));
  return list;
}

export interface PartyLedgerRow {
  date: string;
  created: string;
  type: string;
  ref: string;
  /** party owes more (sales, purchase returns, payments made to them) */
  debit: number;
  /** party owes less (payments received, sale returns, purchases from them) */
  credit: number;
  balance: number;
  /** underlying document id — makes the row clickable to open the bill */
  docId?: string;
  docKind?: "sale" | "purchase" | "sale-return" | "purchase-return";
}

/**
 * Full chronological ledger for one party — every sale, purchase, return and
 * payment that touches them, with a running balance (positive = party owes
 * us / receivable, negative = we owe them / payable). Pass the FULL,
 * unfiltered `payments` array (not just this party's) so `paidViaPayments`
 * can resolve invoice-linked allocations correctly.
 *
 * Shared by the per-party Statement page and the all-parties Ledger report
 * so both always agree on the numbers.
 */
export function buildPartyLedger(
  party: { id: string; openingBalance?: number },
  data: {
    sales: Invoice[];
    purchases: Invoice[];
    saleReturns: Return[];
    purchaseReturns: Return[];
    payments: Payment[];
  },
  dateFrom = "",
  dateTo = "",
): { rows: PartyLedgerRow[]; fullBalance: number; totalDebit: number; totalCredit: number } {
  const entries: Omit<PartyLedgerRow, "balance">[] = [];
  const applied = paidViaPayments(data.payments);

  for (const s of data.sales.filter((x) => x.partyId === party.id)) {
    entries.push({
      date: s.date,
      created: s.createdAt,
      type: "Sale",
      ref: s.number,
      debit: s.total,
      credit: 0,
      docId: s.id,
      docKind: "sale",
    });
    const atBilling = r2((s.paid || 0) - (applied.get(s.id) ?? 0));
    if (atBilling > 0) {
      entries.push({
        date: s.date,
        created: s.createdAt,
        type: "Received with bill",
        ref: s.number,
        debit: 0,
        credit: atBilling,
        docId: s.id,
        docKind: "sale",
      });
    }
  }
  for (const ret of data.saleReturns.filter((x) => x.partyId === party.id)) {
    entries.push({
      date: ret.date,
      created: ret.createdAt,
      type: "Sale Return",
      ref: ret.number,
      debit: 0,
      credit: ret.total,
      docId: ret.id,
      docKind: "sale-return",
    });
  }
  for (const p of data.purchases.filter((x) => x.partyId === party.id)) {
    entries.push({
      date: p.date,
      created: p.createdAt,
      type: "Purchase",
      ref: p.number,
      debit: 0,
      credit: p.total,
      docId: p.id,
      docKind: "purchase",
    });
    const atBilling = r2((p.paid || 0) - (applied.get(p.id) ?? 0));
    if (atBilling > 0) {
      entries.push({
        date: p.date,
        created: p.createdAt,
        type: "Paid with bill",
        ref: p.number,
        debit: atBilling,
        credit: 0,
        docId: p.id,
        docKind: "purchase",
      });
    }
  }
  for (const ret of data.purchaseReturns.filter((x) => x.partyId === party.id)) {
    entries.push({
      date: ret.date,
      created: ret.createdAt,
      type: "Purchase Return",
      ref: ret.number,
      debit: ret.total,
      credit: 0,
      docId: ret.id,
      docKind: "purchase-return",
    });
  }
  for (const pay of data.payments.filter((x) => x.partyId === party.id)) {
    const linked = pay.allocations?.map((a) => a.number).join(", ") ?? pay.ref ?? "";
    if (pay.type === "in") {
      entries.push({
        date: pay.date,
        created: pay.createdAt,
        type: "Payment Received",
        ref: linked || "—",
        debit: 0,
        credit: pay.amount,
      });
    } else {
      entries.push({
        date: pay.date,
        created: pay.createdAt,
        type: "Payment Made",
        ref: linked || "—",
        debit: pay.amount,
        credit: 0,
      });
    }
  }

  entries.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.created ?? "").localeCompare(b.created ?? ""),
  );

  // Current all-time balance, independent of any date filter
  const fullBalance = r2(
    entries.reduce((s, e) => s + e.debit - e.credit, party.openingBalance || 0),
  );

  let running = party.openingBalance || 0;
  const out: PartyLedgerRow[] = [];

  // Date window: transactions before "From" collapse into one
  // "Balance b/f" (brought forward) line, like a proper ledger
  const before = dateFrom ? entries.filter((e) => e.date < dateFrom) : [];
  const window = entries.filter(
    (e) => (!dateFrom || e.date >= dateFrom) && (!dateTo || e.date <= dateTo),
  );
  for (const e of before) {
    running = r2(running + e.debit - e.credit);
  }

  if (dateFrom) {
    out.push({
      date: "",
      created: "",
      type: "Balance b/f",
      ref: "—",
      debit: 0,
      credit: 0,
      balance: running,
    });
  } else if (party.openingBalance) {
    out.push({
      date: "",
      created: "",
      type: "Opening Balance",
      ref: "—",
      debit: party.openingBalance > 0 ? party.openingBalance : 0,
      credit: party.openingBalance < 0 ? -party.openingBalance : 0,
      balance: running,
    });
  }
  for (const e of window) {
    running = r2(running + e.debit - e.credit);
    out.push({ ...e, balance: running });
  }
  const totalDebit = r2(out.reduce((s, e) => s + e.debit, 0));
  const totalCredit = r2(out.reduce((s, e) => s + e.credit, 0));
  return { rows: out, fullBalance, totalDebit, totalCredit };
}

export interface StatementItem {
  name: string;
  qty: number;
  price: number;
  amount: number;
}

export interface StatementCharge {
  label: string;
  amount: number;
}

export interface PartyStatementRow {
  date: string;
  created: string;
  type: string;
  ref: string;
  status?: "Paid" | "Partial" | "Unpaid";
  /** Invoice/return total, or the advance amount for a standalone payment row */
  total: number;
  /** Amount collected/paid against this specific transaction (all-time, folds in later payments) */
  receivedOrPaid: number;
  /** total − receivedOrPaid — what's still outstanding on this one transaction */
  txnBalance: number;
  items?: StatementItem[];
  charges?: StatementCharge[];
  /** Running party balance after this row — positive = receivable, negative = payable */
  balance: number;
  docId?: string;
  docKind?: "sale" | "purchase" | "sale-return" | "purchase-return";
  /** Only meaningful on a sale-return/purchase-return row — see Return's own
   *  doc comment. Absent/"decrease" means netOf() below treats it exactly as
   *  every return always has. */
  direction?: "decrease" | "increase";
  /**
   * The record this row's money moved through, so a screen can say HOW —
   * cash, which bank account, or a split across both.
   *
   * Display only: nothing is ever calculated from it, and every balance in
   * this file is identical with or without it. It exists because a party
   * ledger reading "Payment Received 5,000" and nothing else cannot answer
   * the question asked of it a day later — whether that five thousand is in
   * the drawer or in the bank.
   *
   * Carried as the record rather than a formatted string, because only the
   * caller knows what its bank accounts are called.
   */
  settledBy?: Parameters<typeof splitsOf>[0];
}

/**
 * What a statement row puts in its two money columns.
 *
 * The obvious rule — show which way the balance moved — is wrong, and the
 * shop found it: a bill paid in full at the counter moves the balance by
 * nothing at all, so a 7,500 sale with 7,500 handed over showed an empty
 * row. The money was in the ledger and invisible on it.
 *
 * A bill has TWO movements on one line: goods out at their full value, and
 * whatever came back over the counter. Both are shown. A payment, a return
 * or a write-off has one, and shows one.
 *
 * Derived from the net movement rather than from the record's own settled
 * figure, so the columns can never disagree with the balance beside them:
 * gave − got equals the net for every row, which is asserted rather than
 * hoped for. A return stores its settled amount equal to its total for
 * bookkeeping reasons, and reading that directly would report a second
 * movement that never happened.
 */
export interface LedgerColumns {
  /** Value that left the shop: goods sold, or money paid out. */
  gave: number;
  /** Value that came back: money taken, or goods bought in. */
  got: number;
}

export function ledgerColumns(row: PartyStatementRow, net: number): LedgerColumns {
  const total = row.total || 0;

  if (row.docKind === "sale") {
    // Goods out at full value; the rest of the line is what was settled on
    // the spot — total − net, by definition of how the balance moved.
    return { gave: total, got: Math.max(0, r2(total - net)) };
  }
  if (row.docKind === "purchase") {
    return { got: total, gave: Math.max(0, r2(total + net)) };
  }

  // One direction only.
  return net >= 0 ? { gave: r2(net), got: 0 } : { gave: 0, got: r2(-net) };
}

/**
 * Vyapar-style party statement — one row per transaction (not per debit/
 * credit event like buildPartyLedger), with the invoice's own line items and
 * a running Receivable/Payable balance. Built for the printed/exported
 * Party Statement, which needs to show "what was in this bill" alongside
 * the ledger, not just a flat debit/credit trail.
 *
 * A later Payment allocated to an invoice is folded into that invoice's own
 * `receivedOrPaid` (via invoice.paid) rather than getting its own row — only
 * the unallocated advance portion of a payment becomes a standalone row, so
 * nothing is ever counted twice.
 */
export function buildPartyStatement(
  party: { id: string; openingBalance?: number },
  data: {
    sales: Invoice[];
    purchases: Invoice[];
    saleReturns: Return[];
    purchaseReturns: Return[];
    payments: Payment[];
    /** Optional — see the same note on netPartyPositions. */
    journalVouchers?: JournalVoucher[];
  },
  dateFrom = "",
  dateTo = "",
): { rows: PartyStatementRow[]; fullBalance: number } {
  type Entry = Omit<PartyStatementRow, "balance">;
  const entries: Entry[] = [];

  /* Money that reached a bill through a PAYMENT record, as opposed to cash
   * handed over at the counter when the bill was written.
   *
   * The two have to be told apart because they happen on different DAYS. A
   * bill's `paid` holds both, so crediting all of it against the bill's own
   * date put a payment taken three weeks later on the date of the sale — and
   * a payment that had been fully applied to bills produced no row of its own
   * at all, while one that happened to be an advance did. The same act of
   * taking money therefore appeared in two entirely different places in the
   * ledger depending on how it was applied, which is the "sometimes up,
   * sometimes at the bottom" the client reported.
   *
   * Splitting it costs nothing in accuracy: the bill keeps only what it took
   * on the day, each payment appears on the day it happened, and the closing
   * balance is identical either way — which the audit suite pins. */
  const viaPayments = paidViaPayments(data.payments);
  const directlyPaid = (inv: Invoice) =>
    Math.max(0, r2((inv.paid || 0) - (viaPayments.get(inv.id) ?? 0)));

  const itemsOf = (lineItems: { name: string; qty: number; price: number; amount: number }[]) =>
    lineItems.map((l) => ({ name: l.name, qty: l.qty, price: l.price, amount: l.amount }));

  const statusOf = (total: number, paid: number): "Paid" | "Partial" | "Unpaid" => {
    if (paid <= 0.001) return "Unpaid";
    return r2(total - paid) <= 0.01 ? "Paid" : "Partial";
  };

  for (const s of data.sales.filter((x) => x.partyId === party.id)) {
    const paid = directlyPaid(s);
    const charges: StatementCharge[] = [];
    if (s.shippingCharge) charges.push({ label: "Shipping Charge", amount: s.shippingCharge });
    if (s.discount) charges.push({ label: "Discount", amount: -s.discount });
    entries.push({
      date: s.date,
      created: s.createdAt,
      type: "Sale",
      ref: s.number,
      status: statusOf(s.total, paid),
      total: s.total,
      receivedOrPaid: paid,
      txnBalance: r2(s.total - paid),
      items: itemsOf(s.lineItems),
      charges,
      docId: s.id,
      docKind: "sale",
      // Only when money changed hands on the day. An unpaid bill has no mode
      // to report, and printing the highlighted pill would claim a payment
      // that never happened.
      settledBy: paid > 0.001 ? s : undefined,
    });
  }
  for (const ret of data.saleReturns.filter((x) => x.partyId === party.id)) {
    entries.push({
      date: ret.date,
      created: ret.createdAt,
      type: "Sale Return",
      ref: ret.number,
      total: ret.total,
      receivedOrPaid: ret.total,
      txnBalance: 0,
      items: itemsOf(ret.lineItems),
      docId: ret.id,
      docKind: "sale-return",
      direction: ret.direction,
    });
  }
  for (const p of data.purchases.filter((x) => x.partyId === party.id)) {
    const paid = directlyPaid(p);
    const charges: StatementCharge[] = [];
    if (p.discount) charges.push({ label: "Discount", amount: -p.discount });
    entries.push({
      date: p.date,
      created: p.createdAt,
      type: "Purchase",
      ref: p.number,
      status: statusOf(p.total, paid),
      total: p.total,
      receivedOrPaid: paid,
      txnBalance: r2(p.total - paid),
      items: itemsOf(p.lineItems),
      charges,
      docId: p.id,
      docKind: "purchase",
      settledBy: paid > 0.001 ? p : undefined,
    });
  }
  for (const ret of data.purchaseReturns.filter((x) => x.partyId === party.id)) {
    entries.push({
      date: ret.date,
      created: ret.createdAt,
      type: "Purchase Return",
      ref: ret.number,
      total: ret.total,
      receivedOrPaid: ret.total,
      txnBalance: 0,
      items: itemsOf(ret.lineItems),
      docId: ret.id,
      docKind: "purchase-return",
      direction: ret.direction,
    });
  }
  for (const pay of data.payments.filter((x) => x.partyId === party.id)) {
    const against = pay.allocations?.map((a) => a.number).join(", ") || pay.ref || "Advance";
    if (pay.amount > 0.001) {
      entries.push({
        date: pay.date,
        created: pay.createdAt,
        type: pay.type === "in" ? "Payment Received" : "Payment Made",
        ref: against,
        total: pay.amount,
        receivedOrPaid: pay.amount,
        txnBalance: 0,
        settledBy: pay,
      });
    }
    // A settlement discount closes a bill without the money ever arriving, so
    // it is its own line — folding it into the payment would report cash that
    // was never taken, and leaving it out would leave the bill looking open.
    const written = r2((pay.allocations ?? []).reduce((t, a) => t + (a.discount ?? 0), 0));
    if (written > 0.001) {
      entries.push({
        date: pay.date,
        created: pay.createdAt,
        type: pay.type === "in" ? "Discount Given" : "Discount Received",
        ref: against,
        total: written,
        receivedOrPaid: written,
        txnBalance: 0,
      });
    }
  }
  // A Journal Voucher's party line uses the same direction a sale already
  // does — Debit increases what they owe, Credit decreases it — split into
  // two distinct row types (never a single signed one) so netOf below can
  // give each an explicit, unambiguous sign the same way Sale vs Sale Return
  // already are two types rather than one.
  for (const jv of data.journalVouchers ?? []) {
    for (const l of jv.lines) {
      if (l.kind !== "party" || l.refId !== party.id) continue;
      const net = r2(l.debit - l.credit);
      if (!net) continue;
      const amt = Math.abs(net);
      entries.push({
        date: jv.date,
        created: jv.createdAt,
        type: net > 0 ? "Journal Entry (Dr)" : "Journal Entry (Cr)",
        ref: `${jv.number} — ${jv.narration}`,
        total: amt,
        receivedOrPaid: net > 0 ? 0 : amt,
        txnBalance: net > 0 ? amt : 0,
      });
    }
  }

  entries.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.created ?? "").localeCompare(b.created ?? ""),
  );

  // Net ledger effect of each row: sales/purchase-returns increase what the
  // party owes us; purchases/sale-returns/payments reduce it (or increase
  // what we owe them). `receivedOrPaid` on a sale/purchase already nets
  // against that same row's `total`, so nothing here is counted twice.
  const netOf = (e: Entry) => {
    if (e.docKind === "sale") return e.total - e.receivedOrPaid;
    if (e.docKind === "purchase") return -(e.total - e.receivedOrPaid);
    if (e.docKind === "sale-return") return -e.total * returnDirMul(e);
    if (e.docKind === "purchase-return") return e.total * returnDirMul(e);
    // A Journal Entry row's own type already says which direction it moved —
    // split at push time into two distinct types for exactly this reason,
    // rather than relying on a sign carried inside `total`.
    if (e.type === "Journal Entry (Dr)") return e.total;
    if (e.type === "Journal Entry (Cr)") return -e.total;
    // Every payment and write-off is now its own dated row (see above), so
    // this arm carries all of them, not just a standalone advance.
    return e.type === "Payment Received" || e.type === "Discount Given" ? -e.total : e.total;
  };

  const fullBalance = r2(entries.reduce((s, e) => s + netOf(e), party.openingBalance || 0));

  let running = party.openingBalance || 0;
  const out: PartyStatementRow[] = [];

  const before = dateFrom ? entries.filter((e) => e.date < dateFrom) : [];
  const window = entries.filter(
    (e) => (!dateFrom || e.date >= dateFrom) && (!dateTo || e.date <= dateTo),
  );
  for (const e of before) running = r2(running + netOf(e));

  out.push({
    date: "",
    created: "",
    type: dateFrom ? "Balance b/f" : "Beginning Balance",
    ref: "—",
    total: 0,
    receivedOrPaid: 0,
    txnBalance: 0,
    balance: running,
  });
  for (const e of window) {
    running = r2(running + netOf(e));
    out.push({ ...e, balance: running });
  }
  return { rows: out, fullBalance };
}

export interface BankLedgerRow {
  date: string;
  created: string;
  type: string;
  ref: string;
  debit: number;
  /** money entering the account (payment in, sale, deposit) */
  credit: number;
  balance: number;
  docId?: string;
  docKind?: "sale" | "purchase";
  /**
   * Set on the two legs of a cash/bank transfer, so the passbook can offer
   * to correct one.
   *
   * A transfer is two records — money out of one account, into the other —
   * and the only safe way to change it is as the single thing it is. Without
   * this the passbook had no way of telling a transfer leg apart from an
   * ordinary deposit, so it offered nothing at all and a mistyped transfer
   * had to be deleted from the Cash page and re-entered from memory.
   */
  transferId?: string;
}

/**
 * Full passbook-style ledger for one bank account — every sale/purchase
 * settled directly into it, every Payments-page in/out tied to it, every
 * bank-mode expense paid from it, and every manual deposit/withdrawal, with
 * a running balance. Standard passbook sign convention: Credit = money in,
 * Debit = money out (opposite of the party ledger's convention, where Debit
 * means the party owes more).
 */
export function buildBankLedger(
  bank: { id: string; openingBalance?: number },
  data: {
    sales: Invoice[];
    purchases: Invoice[];
    payments: Payment[];
    bankTxns: BankTxn[];
    expenses?: Expense[];
    journalVouchers?: JournalVoucher[];
  },
  dateFrom = "",
  dateTo = "",
): { rows: BankLedgerRow[]; fullBalance: number; totalDebit: number; totalCredit: number } {
  const entries: Omit<BankLedgerRow, "balance">[] = [];

  /* Read through the split rows, not the document's single bankId.
     A bill can now put part of its money in one account and part in the
     drawer — or in a second account — and each account's ledger must show
     its own share and nothing else. For a bill with no splits this is the
     same figure bankPaidAmount always gave. */
  for (const s of data.sales) {
    const credit = bankParts(s).get(bank.id) ?? 0;
    if (credit <= 0) continue;
    entries.push({
      date: s.date,
      created: s.createdAt,
      type: "Sale Receipt",
      ref: `${s.number} — ${s.partyName}`,
      debit: 0,
      credit,
      docId: s.id,
      docKind: "sale",
    });
  }
  for (const p of data.purchases) {
    const debit = bankParts(p).get(bank.id) ?? 0;
    if (debit <= 0) continue;
    entries.push({
      date: p.date,
      created: p.createdAt,
      type: "Purchase Payment",
      ref: `${p.number} — ${p.partyName}`,
      debit,
      credit: 0,
      docId: p.id,
      docKind: "purchase",
    });
  }
  /* Through the rows, like the bills above. A part-cash receipt has no
     top-level bankId, so filtering on that missed it entirely — and because
     the shop's balance HAD already been moved by the save, this passbook
     would have disagreed with the account it describes. bankRepair
     re-derives balances from exactly these entries, so the next repair would
     have "corrected" the balance downward and taken the money with it. */
  for (const pay of data.payments) {
    const amount = bankParts(pay).get(bank.id) ?? 0;
    if (amount <= 0) continue;
    entries.push({
      date: pay.date,
      created: pay.createdAt,
      type: pay.type === "in" ? "Payment Received" : "Payment Made",
      ref: pay.partyName,
      debit: pay.type === "in" ? 0 : amount,
      credit: pay.type === "in" ? amount : 0,
    });
  }
  for (const t of data.bankTxns.filter((x) => x.bankId === bank.id)) {
    if (t.type === "deposit") {
      entries.push({
        date: t.date,
        created: t.createdAt,
        type: "Deposit",
        ref: t.notes || "—",
        debit: 0,
        credit: t.amount,
        transferId: t.transferId,
        // docKind deliberately absent (openRow only acts when BOTH are set)
        // — this exists purely so an un-transferId'd old transfer leg can
        // still be traced back to its raw record (see cashLegFor usage in
        // bank_.$id.tsx), not to make the row itself clickable-to-navigate.
        docId: t.id,
      });
    } else if (t.type === "withdraw") {
      entries.push({
        date: t.date,
        created: t.createdAt,
        type: "Withdrawal",
        ref: t.notes || "—",
        debit: t.amount,
        credit: 0,
        transferId: t.transferId,
        docId: t.id,
      });
    }
  }
  for (const ex of data.expenses ?? []) {
    const amount = bankParts(ex).get(bank.id) ?? 0;
    if (amount <= 0) continue;
    entries.push({
      date: ex.date,
      created: ex.createdAt,
      type: "Expense",
      ref: ex.category + (ex.notes ? ` — ${ex.notes}` : ""),
      debit: amount,
      credit: 0,
    });
  }
  // JournalLine's own Debit/Credit are standard double-entry (Debit = money
  // IN to this bank, same direction BankRepo's stored balance was actually
  // adjusted by at save time) — INVERTED here into this ledger's own
  // passbook convention (Credit = money in), same as every other entry type
  // above already uses. See JournalLine's doc comment in src/types/index.ts.
  for (const jv of data.journalVouchers ?? []) {
    for (const l of jv.lines) {
      if (l.kind !== "bank" || l.refId !== bank.id) continue;
      const net = r2(l.debit - l.credit);
      if (!net) continue;
      entries.push({
        date: jv.date,
        created: jv.createdAt,
        type: "Journal Voucher",
        ref: `${jv.number} — ${jv.narration}`,
        debit: net < 0 ? -net : 0,
        credit: net > 0 ? net : 0,
      });
    }
  }

  entries.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.created ?? "").localeCompare(b.created ?? ""),
  );

  const fullBalance = r2(
    entries.reduce((s, e) => s + e.credit - e.debit, bank.openingBalance || 0),
  );

  let running = bank.openingBalance || 0;
  const out: BankLedgerRow[] = [];
  const before = dateFrom ? entries.filter((e) => e.date < dateFrom) : [];
  const window = entries.filter(
    (e) => (!dateFrom || e.date >= dateFrom) && (!dateTo || e.date <= dateTo),
  );
  for (const e of before) {
    running = r2(running + e.credit - e.debit);
  }

  if (dateFrom) {
    out.push({
      date: "",
      created: "",
      type: "Balance b/f",
      ref: "—",
      debit: 0,
      credit: 0,
      balance: running,
    });
  } else if (bank.openingBalance) {
    out.push({
      date: "",
      created: "",
      type: "Opening Balance",
      ref: "—",
      debit: bank.openingBalance < 0 ? -bank.openingBalance : 0,
      credit: bank.openingBalance > 0 ? bank.openingBalance : 0,
      balance: running,
    });
  }
  for (const e of window) {
    running = r2(running + e.credit - e.debit);
    out.push({ ...e, balance: running });
  }
  const totalDebit = r2(out.reduce((s, e) => s + e.debit, 0));
  const totalCredit = r2(out.reduce((s, e) => s + e.credit, 0));
  return { rows: out, fullBalance, totalDebit, totalCredit };
}

export interface SimpleLedgerRow {
  date: string;
  particulars: string;
  qty: string;
  credit: number;
  debit: number;
  balance: number;
}

/**
 * Collapse a party statement into the plain one-line-per-transaction ledger
 * — Date / Particulars / Quantity / Credit / Debit / Balance — that people
 * expect to hand to a customer or an accountant.
 *
 * Credit and debit are derived from the MOVEMENT in the running balance
 * rather than re-deriving each document's sign, so this can never disagree
 * with the statement it came from.
 *
 * Lives here, not in the statement page, because the page and the bulk
 * ledger export both render it and must produce identical rows.
 */
export function buildSimpleLedgerRows(rows: PartyStatementRow[]): SimpleLedgerRow[] {
  const particularsOf = (r: PartyStatementRow) => {
    if (r.docKind === "sale") return `Sal. Bill No.: ${r.ref}`;
    if (r.docKind === "purchase") return `Pur. Bill No.: ${r.ref}`;
    if (r.docKind === "sale-return") return `Sale Return No.: ${r.ref}`;
    if (r.docKind === "purchase-return") return `Purchase Return No.: ${r.ref}`;
    return r.type; // Payment Received / Made / Beginning Balance / Balance b/f
  };
  let prevBalance = 0;
  return rows.map((r, i) => {
    if (i === 0) {
      prevBalance = r.balance;
      return {
        date: "",
        particulars: r.type === "Balance b/f" ? "Balance B/F" : "Opening Balance",
        qty: "",
        credit: 0,
        debit: 0,
        balance: r.balance,
      };
    }
    const delta = r2(r.balance - prevBalance);
    prevBalance = r.balance;
    const qty = r.items?.length ? r.items.reduce((s, it) => s + it.qty, 0) : null;
    return {
      date: r.date,
      particulars: particularsOf(r),
      qty: qty != null ? String(qty) : "",
      credit: delta < 0 ? -delta : 0,
      debit: delta > 0 ? delta : 0,
      balance: r.balance,
    };
  });
}

/**
 * Net-of-GST value of a set of bills or returns — `total` minus the output
 * tax inside it.
 *
 * Profit must never be computed off `invoice.total`: that figure includes
 * the GST collected from the customer, which is money held on behalf of the
 * tax authority, not earnings. Cost of goods sold, by contrast, is a
 * tax-exclusive line price (see computeCogs), so mixing the two overstated
 * every profit figure in the app by exactly the output GST on the period's
 * sales. Bill-level discount, shipping and round-off all stay in, since
 * those really are part of what the shop earned.
 */
export function valueExTax(
  docs: { total?: number; taxAmount?: number; gstEnabled?: boolean }[],
): number {
  return r2(
    docs.reduce(
      // A non-GST bill carries no tax to strip — guarded explicitly rather
      // than trusting taxAmount to be 0 on legacy/imported documents.
      (s, d) => s + (d.total || 0) - (d.gstEnabled === false ? 0 : d.taxAmount || 0),
      0,
    ),
  );
}

/**
 * Same ex-tax calculation as `valueExTax`, but direction-aware for a set of
 * Returns specifically — a plain decrease note's value comes back POSITIVE
 * (so `revenue - returnValueExTax(saleReturns)` subtracts it, exactly as
 * every P&L calculation already did), while an `increase` note comes back
 * NEGATIVE, so that same subtraction turns into an addition. Kept separate
 * from `valueExTax` because only a Return carries a direction at all.
 */
export function returnValueExTax(returns: Return[]): number {
  return r2(
    returns.reduce(
      (s, r) =>
        s +
        ((r.total || 0) - (r.gstEnabled === false ? 0 : r.taxAmount || 0)) * returnDirMul(r),
      0,
    ),
  );
}

/** Cost of goods sold from per-line cost snapshots, falling back to the
 * item's current purchase price for lines saved before costPrice existed. */
export function computeCogs(sales: Invoice[], saleReturns: Return[], items: Item[]): number {
  const cost = new Map(items.map((i) => [i.id, i.purchasePrice] as const));
  const lineCost = (l: { itemId: string; qty: number; costPrice?: number }) =>
    (l.costPrice ?? cost.get(l.itemId) ?? 0) * l.qty;
  const sold = sales.reduce((s, inv) => s + inv.lineItems.reduce((a, l) => a + lineCost(l), 0), 0);
  // An adjustment-only note's line qty is symbolic (which item a price/tax
  // correction relates to), not a real physical return — no stock moved
  // (see ReturnForm's skipped stock reversal), so it must not reduce COGS
  // as if goods had actually come back.
  const returned = saleReturns
    .filter((ret) => !ret.isAdjustmentOnly)
    .reduce((s, ret) => s + ret.lineItems.reduce((a, l) => a + lineCost(l), 0), 0);
  return r2(sold - returned);
}

/** One GST-rate row in a return/report: taxable value and tax, already split
 *  into the head(s) it actually carries. `tax` is cgst+sgst+igst — kept as
 *  its own field so a caller summing the row doesn't have to know that. */
export interface GstBucket {
  rate: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  tax: number;
}

const buyerStateOf = (doc: { placeOfSupply?: string; partyGstin?: string }) =>
  doc.placeOfSupply || stateFromGstin(doc.partyGstin)?.code;

/**
 * GST buckets for a return/report — sales or purchases, netted against their
 * own returns, each document taxed CGST+SGST or IGST exactly as it actually
 * was at invoice time rather than a blanket 50/50 assumption. This is the
 * ONE place that decision is made for reporting, so the GST page and the
 * Reports → GST Summary can never disagree with each other, or with the bill
 * being reported on.
 *
 * A `Return` carries no GSTIN/place-of-supply of its own (see `Return` in
 * src/types/index.ts) — it nets against whichever tax head its OWN ORIGINAL
 * invoice used, found by matching `originalRef` against `originals` (pass
 * the FULL, unfiltered invoice list here, since the original can fall
 * outside whatever date range the return itself is being reported in). A
 * return whose original can't be found (edited away, or predates this
 * lookup) falls back to intra-state — the same default `supplyKind` already
 * uses for an unknown party, so it never crashes and never invents an IGST
 * split from nothing.
 */
/** A document's own taxable value grouped by GST rate, before any bill-level
 *  discount/shipping fold-in — the one fact every document (invoice or
 *  return, whichever tax-calc version it was billed under) can always
 *  supply from its line items alone. */
function lineRateBuckets(lineItems: LineItem[]): { rate: number; taxable: number }[] {
  const byRate = new Map<number, number>();
  for (const l of lineItems) {
    const qty = l.qty ?? 0;
    const price = l.price ?? 0;
    const discountPct = l.discountPct ?? 0;
    const gstRate = l.gstRate ?? 0;
    const taxable = qty * price * (1 - discountPct / 100);
    byRate.set(gstRate, (byRate.get(gstRate) ?? 0) + taxable);
  }
  return Array.from(byRate, ([rate, taxable]) => ({ rate, taxable }));
}

export function gstBuckets(
  docs: Invoice[],
  returns: Return[],
  originals: Invoice[],
  sellerStateCode: string | undefined,
): GstBucket[] {
  const map = new Map<number, GstBucket>();
  const merge = (
    sign: 1 | -1,
    rate: number,
    taxable: number,
    tax: number,
    kind: "intra" | "inter",
  ) => {
    const split = splitTax(tax, kind);
    const cur = map.get(rate) ?? { rate, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
    cur.taxable += sign * taxable;
    cur.cgst += sign * split.cgst;
    cur.sgst += sign * split.sgst;
    cur.igst += sign * split.igst;
    cur.tax += sign * tax;
    map.set(rate, cur);
  };
  for (const inv of docs) {
    if (inv.gstEnabled === false) continue;
    const kind = supplyKind(sellerStateCode, buyerStateOf(inv));
    const buckets = lineRateBuckets(inv.lineItems);
    // A GST-compliant (taxCalcVersion 2) invoice folds Extra Discount and
    // Shipping into the taxable value via the exact same allocation used to
    // save it, so this report's rate-by-rate split can never disagree with
    // the invoice's own stored taxAmount. An invoice from before this
    // existed never had that fold-in, so it stays pure per-line — exactly
    // how it was actually taxed, and an already-filed period's report must
    // keep reading it that way, not get silently restated.
    const adjusted =
      inv.taxCalcVersion === 2
        ? allocateAcrossRateBuckets(buckets, (inv.shippingCharge ?? 0) - inv.discount)
        : buckets.map((b) => ({ ...b, tax: b.taxable * (b.rate / 100) }));
    for (const b of adjusted) merge(1, b.rate, b.taxable, b.tax, kind);
  }
  for (const ret of returns) {
    if (ret.gstEnabled === false) continue;
    const orig = originals.find((o) => o.number === (ret.originalRef ?? "").trim());
    const kind = supplyKind(sellerStateCode, orig ? buyerStateOf(orig) : undefined);
    const sign = (-1 * returnDirMul(ret)) as 1 | -1;
    for (const b of lineRateBuckets(ret.lineItems)) {
      merge(sign, b.rate, b.taxable, b.taxable * (b.rate / 100), kind);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.rate - b.rate);
}

/** One HSN+rate row for the GSTR-1 "HSN Summary of Outward/Inward Supplies"
 *  table — same shape as GstBucket plus `qty`, grouped by HSN code as well as
 *  rate. `hsn: ""` groups every line with no code captured under one
 *  explicit bucket, so a gap in the item master shows up as a worklist entry
 *  instead of silently merging into whichever other line happens to share
 *  its rate. */
export interface HsnBucket {
  hsn: string;
  rate: number;
  qty: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  tax: number;
}

/**
 * HSN Summary buckets — the exact same netting and CGST/SGST-vs-IGST rules as
 * `gstBuckets()` (see its comment), just grouped by HSN code first and GST
 * rate second to match the GSTR-1 HSN Summary table. Built from the same
 * per-line tax math so this can never disagree with the plain rate-only GST
 * page for the same period.
 */
/** A document's own taxable value + qty grouped by HSN code AND rate, before
 *  any bill-level discount/shipping fold-in. */
function lineHsnBuckets(
  lineItems: LineItem[],
): { hsn: string; rate: number; qty: number; taxable: number }[] {
  const byKey = new Map<string, { hsn: string; rate: number; qty: number; taxable: number }>();
  for (const l of lineItems) {
    const qty = l.qty ?? 0;
    const price = l.price ?? 0;
    const discountPct = l.discountPct ?? 0;
    const gstRate = l.gstRate ?? 0;
    const hsn = (l.hsn ?? "").trim();
    const taxable = qty * price * (1 - discountPct / 100);
    const key = `${hsn}__${gstRate}`;
    const cur = byKey.get(key) ?? { hsn, rate: gstRate, qty: 0, taxable: 0 };
    cur.qty += qty;
    cur.taxable += taxable;
    byKey.set(key, cur);
  }
  return Array.from(byKey.values());
}

export function hsnSummary(
  docs: Invoice[],
  returns: Return[],
  originals: Invoice[],
  sellerStateCode: string | undefined,
): HsnBucket[] {
  const map = new Map<string, HsnBucket>();
  const merge = (
    sign: 1 | -1,
    hsn: string,
    rate: number,
    qty: number,
    taxable: number,
    tax: number,
    kind: "intra" | "inter",
  ) => {
    const split = splitTax(tax, kind);
    const key = `${hsn}__${rate}`;
    const cur = map.get(key) ?? { hsn, rate, qty: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
    cur.qty += sign * qty;
    cur.taxable += sign * taxable;
    cur.cgst += sign * split.cgst;
    cur.sgst += sign * split.sgst;
    cur.igst += sign * split.igst;
    cur.tax += sign * tax;
    map.set(key, cur);
  };
  for (const inv of docs) {
    if (inv.gstEnabled === false) continue;
    const kind = supplyKind(sellerStateCode, buyerStateOf(inv));
    const buckets = lineHsnBuckets(inv.lineItems);
    // Same reasoning as gstBuckets(): a GST-compliant (taxCalcVersion 2)
    // invoice's Extra Discount/Shipping are allocated across its own
    // (HSN, rate) buckets by taxable-value share — the most granular level
    // this report actually shows — so the HSN Summary can never disagree
    // with the plain rate-only GST page for the same invoice. An invoice
    // from before this existed stays pure per-line, exactly as filed.
    const adjusted =
      inv.taxCalcVersion === 2
        ? allocateAcrossRateBuckets(buckets, (inv.shippingCharge ?? 0) - inv.discount).map(
          (b, i) => ({ ...b, hsn: buckets[i].hsn, qty: buckets[i].qty }),
        )
        : buckets.map((b) => ({ ...b, tax: b.taxable * (b.rate / 100) }));
    for (const b of adjusted) merge(1, b.hsn, b.rate, b.qty, b.taxable, b.tax, kind);
  }
  for (const ret of returns) {
    if (ret.gstEnabled === false) continue;
    const orig = originals.find((o) => o.number === (ret.originalRef ?? "").trim());
    const kind = supplyKind(sellerStateCode, orig ? buyerStateOf(orig) : undefined);
    const sign = (-1 * returnDirMul(ret)) as 1 | -1;
    for (const b of lineHsnBuckets(ret.lineItems)) {
      merge(sign, b.hsn, b.rate, b.qty, b.taxable, b.taxable * (b.rate / 100), kind);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate);
}
