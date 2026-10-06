/**
 * M Décor production audit harness.
 * Imports the REAL calculation library (src/lib/ledger.ts) and hammers it
 * with randomized business scenarios ("monkey testing"), asserting the
 * accounting invariants that must never break.
 */
import {
  partyBalances,
  modeFlows,
  cashFlows,
  bankFlows,
  netFlow,
  computeCogs,
  allocatedAmount,
  advanceAmount,
  paidViaPayments,
  valueExTax,
  buildBankLedger,
  totalSettlementDiscount,
  netPartyPositions,
  buildPartyStatement,
  spreadFifo,
} from "@/lib/ledger";
import type {
  PaymentSplit,
  StockAdjustment,
  BankTxn,
  CashAdjustment,
  Invoice,
  Payment,
  Return,
  Item,
  Expense,
  LineItem,
  CashAdjustment,
  PaymentMode,
  BankAccount,
} from "@/types";
import { Repository } from "@/repositories/base";
import { correctBankPaidAmount, planBankRepair } from "@/lib/bankRepair";
import { planStockRepair } from "@/lib/dataRepair";
import {
  splitsOf,
  cashPart,
  bankParts,
  unassignedPart,
  splitProblems,
  describePayment,
  largestSplitMode,
} from "@/lib/paymentSplit";
import { readFileSync } from "node:fs";
import { ledgerColumns } from "@/lib/ledger";
import {
  classifySendFailure,
  isDue,
  needsAttention,
  retryDelayMs,
  queuedMessage,
  MAX_ATTEMPTS,
  CLAIM_STALE_MS,
  type OutboxItem,
} from "@/lib/outbox";
import { transferLegsFor } from "@/lib/transferLegs";
import { EstimateRepo, nextEstimateNumber } from "@/repositories";
import { popupRect } from "@/lib/popupRect";
import {
  ewayRequired,
  validityDays,
  partBRequired,
  canRaiseFor,
  whoGenerates,
  EXEMPTION_LABELS,
} from "@/lib/ewayBill";
import {
  estimateSpec,
  ESTIMATE_KINDS,
  ESTIMATE_MOVES_STOCK,
  ESTIMATE_POSTS_TO_LEDGER,
  canConvert as canConvertEstimate,
  isExpired,
  seriesOf,
  carriedFields,
  advanceAgainst,
  balanceAfterAdvance,
  type EstimateKind,
} from "@/lib/estimates";
import { GST_STATES, readGstin, stateFromGstin, supplyKind, splitTax } from "@/lib/gstin";
import {
  MAX_DOC_BYTES,
  prettySize,
  suggestedName,
  validateUpload,
  storagePathFor,
  docMatches,
} from "@/lib/businessDocs";
import {
  deriveLinkState,
  linkSeverity,
  needsScan,
  linkHeadline,
  linkAdvice,
  sinceLabel,
  LINK_GRACE_MS,
} from "@/lib/whatsappLink";

let passed = 0,
  failed = 0;
const fails: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  if (fails.length < 20) fails.push(msg);
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const approx = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps;

// Seeded RNG for reproducible runs
let seed = 20260702;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const ri = (max: number) => Math.floor(rnd() * max);
const pick = <T>(a: T[]) => a[ri(a.length)];
let idCounter = 0;
const nid = () => `id${++idCounter}`;

/* ═══════ TEST 1: Invoice totals formula — 5000 random bills ═══════ */
// Replicates InvoiceForm.recalc exactly and asserts the printed columns
// (taxable subtotal + GST − extra discount + round off) reconcile to Total.
for (let t = 0; t < 5000; t++) {
  const nLines = 1 + ri(8);
  const lines = Array.from({ length: nLines }, () => ({
    qty: r2(0.5 + rnd() * 20),
    price: r2(rnd() * 5000),
    discountPct: ri(4) === 0 ? ri(30) : 0,
    gstRate: pick([0, 5, 12, 18, 28]),
  }));
  const discount = ri(3) === 0 ? r2(rnd() * 50) : 0;
  const roundEnabled = ri(4) !== 0;
  // exact copy of recalc math
  const afterLineDisc = r2(
    lines.reduce((s, l) => s + r2(l.qty * l.price * (1 - l.discountPct / 100)), 0),
  );
  const taxAmount = r2(
    lines.reduce(
      (s, l) => s + r2(r2(l.qty * l.price * (1 - l.discountPct / 100)) * (l.gstRate / 100)),
      0,
    ),
  );
  const rawTotal = Math.max(0, r2(afterLineDisc + taxAmount - discount));
  const total = roundEnabled ? Math.round(rawTotal) : rawTotal;
  const roundOff = r2(total - rawTotal);

  assert(!roundEnabled || Number.isInteger(total), `T1: rounded total not whole rupee: ${total}`);
  assert(Math.abs(roundOff) <= 0.5 + 1e-9, `T1: roundOff out of range: ${roundOff}`);
  // What the printed bill shows must add up:
  const printed = r2(afterLineDisc + taxAmount - discount + roundOff);
  assert(approx(printed, total), `T1: printed columns ${printed} != total ${total}`);
}

/* ═══════ TEST 2: Party balances — 300 random books ═══════ */
for (let t = 0; t < 300; t++) {
  const partyIds = Array.from({ length: 1 + ri(5) }, () => nid());
  const invoices: Invoice[] = [];
  const returns: Return[] = [];
  const payments: Payment[] = [];

  for (let i = 0; i < 2 + ri(20); i++) {
    const pid = pick(partyIds);
    const total = r2(100 + rnd() * 9000);
    const initialPaid = ri(3) === 0 ? r2(rnd() * total) : 0;
    invoices.push({
      id: nid(),
      number: `INV-${i}`,
      date: "2026-07-01",
      partyId: pid,
      partyName: pid,
      lineItems: [],
      subtotal: total,
      discount: 0,
      taxAmount: 0,
      total,
      paid: initialPaid,
      paymentMode: "cash",
      createdAt: "",
    });
  }
  for (const inv of invoices) {
    if (ri(3) === 0) {
      // a payment applied against this invoice
      const due = r2(inv.total - inv.paid);
      if (due > 1) {
        const applyAmt = r2(due * (0.3 + rnd() * 0.7));
        inv.paid = r2(inv.paid + applyAmt); // what the app does on apply
        payments.push({
          id: nid(),
          date: "2026-07-02",
          partyId: inv.partyId,
          partyName: inv.partyName,
          type: "in",
          amount: applyAmt,
          mode: pick(["cash", "bank", "upi"] as PaymentMode[]),
          allocations: [{ invoiceId: inv.id, number: inv.number, amount: applyAmt }],
          createdAt: "",
        });
      }
    }
    if (ri(5) === 0) {
      returns.push({
        id: nid(),
        number: `CR-${inv.number}`,
        date: "2026-07-03",
        partyId: inv.partyId,
        partyName: inv.partyName,
        lineItems: [],
        subtotal: 0,
        taxAmount: 0,
        total: r2(inv.total * 0.2),
        createdAt: "",
      });
    }
  }
  // pure advances
  for (let i = 0; i < ri(4); i++) {
    const pid = pick(partyIds);
    payments.push({
      id: nid(),
      date: "2026-07-02",
      partyId: pid,
      partyName: pid,
      type: "in",
      amount: r2(50 + rnd() * 500),
      mode: "cash",
      createdAt: "",
    });
  }

  const balances = partyBalances(invoices, returns, payments);
  for (const b of balances) {
    // independent naive recomputation
    const inv = invoices.filter((x) => x.partyId === b.partyId);
    const ret = returns.filter((x) => x.partyId === b.partyId);
    const pay = payments.filter((x) => x.partyId === b.partyId);
    const invoiced = r2(inv.reduce((s, x) => s + x.total, 0));
    const settled = r2(inv.reduce((s, x) => s + x.paid, 0));
    const returned = r2(ret.reduce((s, x) => s + x.total, 0));
    const advances = r2(
      pay.reduce(
        (s, p) => s + (p.amount - (p.allocations ?? []).reduce((a, x) => a + x.amount, 0)),
        0,
      ),
    );
    const expect = r2(invoiced - returned - settled - advances);
    assert(approx(b.balance, expect), `T2: balance ${b.balance} != naive ${expect}`);
    // every allocated rupee is inside invoice.paid — money counted exactly once
    for (const p of pay) {
      assert(allocatedAmount(p) <= p.amount + 0.001, `T2: allocated > amount`);
      assert(approx(advanceAmount(p), p.amount - allocatedAmount(p)), `T2: advance mismatch`);
    }
  }
}

/* ═══════ TEST 3: Cash/bank flows never double-count applied payments ═══════ */
for (let t = 0; t < 300; t++) {
  // one cash invoice: paid 200 at billing, then 300 applied via a UPI payment
  const inv: Invoice = {
    id: nid(),
    number: "INV-X",
    date: "2026-07-01",
    partyId: "p",
    partyName: "p",
    lineItems: [],
    subtotal: 1000,
    discount: 0,
    taxAmount: 0,
    total: 1000,
    paid: 500,
    paymentMode: "cash",
    createdAt: "",
  };
  const pay: Payment = {
    id: nid(),
    date: "2026-07-02",
    partyId: "p",
    partyName: "p",
    type: "in",
    amount: 300,
    mode: "upi",
    allocations: [{ invoiceId: inv.id, number: inv.number, amount: 300 }],
    createdAt: "",
  };
  const cash = netFlow(cashFlows([inv], [], [], [pay], []));
  const bank = netFlow(bankFlows([inv], [], [], [pay]));
  assert(approx(cash, 200), `T3: cash ${cash} != 200 (initial cash only)`);
  assert(approx(bank, 300), `T3: bank ${bank} != 300 (UPI payment only)`);
  assert(approx(cash + bank, inv.paid), `T3: cash+bank != invoice.paid`);
}

/* ═══════ TEST 4: COGS ═══════ */
{
  const items: Item[] = [
    {
      id: "i1",
      name: "A",
      unit: "pcs",
      gstRate: 0,
      purchasePrice: 80,
      salePrice: 100,
      stock: 0,
      openingStock: 0,
      createdAt: "",
    },
  ];
  const line = (qty: number, costPrice?: number): LineItem => ({
    id: nid(),
    itemId: "i1",
    name: "A",
    qty,
    unit: "pcs",
    price: 100,
    discountPct: 0,
    gstRate: 0,
    amount: qty * 100,
    costPrice,
  });
  const sales: Invoice[] = [
    {
      id: nid(),
      number: "S1",
      date: "2026-07-01",
      partyId: "p",
      partyName: "p",
      lineItems: [line(2, 70), line(3)],
      subtotal: 500,
      discount: 0,
      taxAmount: 0,
      total: 500,
      paid: 0,
      paymentMode: "cash",
      createdAt: "",
    },
  ];
  const rets: Return[] = [
    {
      id: nid(),
      number: "CR1",
      date: "2026-07-02",
      partyId: "p",
      partyName: "p",
      lineItems: [line(1, 70)],
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      createdAt: "",
    },
  ];
  // 2×70 (snapshot) + 3×80 (fallback) − 1×70 (returned) = 310
  assert(approx(computeCogs(sales, rets, items), 310), `T4: COGS != 310`);
}

/* ═══════ TEST 5: MONKEY — 20,000 random stock operations ═══════ */
// Simulates the exact mutation sequences the app performs and checks
// stock always equals opening + everything-in − everything-out.
{
  type Doc = { qty: number; itemId: string };
  const item = { opening: 100, stock: 100 };
  const salesDocs = new Map<string, Doc>();
  const purchaseDocs = new Map<string, Doc>();
  const sRetDocs = new Map<string, Doc>();
  const pRetDocs = new Map<string, Doc>();
  let adjNet = 0;
  let openingEdits = 0;

  const expectStock = () => {
    let s = item.opening;
    for (const d of purchaseDocs.values()) s += d.qty;
    for (const d of salesDocs.values()) s -= d.qty;
    for (const d of sRetDocs.values()) s += d.qty;
    for (const d of pRetDocs.values()) s -= d.qty;
    return r2(s + adjNet);
  };
  const adj = (delta: number) => {
    item.stock = r2(item.stock + delta);
  };

  for (let op = 0; op < 20000; op++) {
    const kind = ri(10);
    const qty = r2(0.5 + rnd() * 10);
    if (kind === 0) {
      // new sale (app: stock −qty)
      const id = nid();
      salesDocs.set(id, { qty, itemId: "i" });
      adj(-qty);
    } else if (kind === 1) {
      // new purchase (+qty)
      const id = nid();
      purchaseDocs.set(id, { qty, itemId: "i" });
      adj(qty);
    } else if (kind === 2 && salesDocs.size) {
      // edit sale (reverse old, apply new)
      const id = pick([...salesDocs.keys()]);
      const old = salesDocs.get(id)!;
      adj(old.qty); // reversal
      old.qty = qty;
      adj(-qty); // re-apply
    } else if (kind === 3 && salesDocs.size) {
      // delete sale (+qty back)
      const id = pick([...salesDocs.keys()]);
      adj(salesDocs.get(id)!.qty);
      salesDocs.delete(id);
    } else if (kind === 4 && purchaseDocs.size) {
      // delete purchase (−qty)
      const id = pick([...purchaseDocs.keys()]);
      adj(-purchaseDocs.get(id)!.qty);
      purchaseDocs.delete(id);
    } else if (kind === 5) {
      // sale return (+qty)
      const id = nid();
      sRetDocs.set(id, { qty, itemId: "i" });
      adj(qty);
    } else if (kind === 6) {
      // purchase return (−qty)
      const id = nid();
      pRetDocs.set(id, { qty, itemId: "i" });
      adj(-qty);
    } else if (kind === 7 && sRetDocs.size) {
      // delete sale return (−qty)
      const id = pick([...sRetDocs.keys()]);
      adj(-sRetDocs.get(id)!.qty);
      sRetDocs.delete(id);
    } else if (kind === 8) {
      // manual stock adjustment
      const delta = (ri(2) ? 1 : -1) * qty;
      adjNet = r2(adjNet + delta);
      adj(delta);
    } else if (kind === 9) {
      // edit opening stock (delta shifts current)
      const newOpening = r2(rnd() * 200);
      const delta = r2(newOpening - item.opening);
      item.opening = newOpening;
      adj(delta);
      openingEdits++;
    }
    if (op % 100 === 0 || op === 19999) {
      assert(
        approx(item.stock, expectStock(), 0.5),
        `T5 op${op}: stock ${item.stock} != expected ${expectStock()}`,
      );
    }
  }
  assert(approx(item.stock, expectStock(), 0.5), `T5 final: stock drifted`);
}

/* ═══════ TEST 6: MONKEY — payment lifecycle (create/edit/delete) ═══════ */
{
  const invoices: Invoice[] = Array.from({ length: 12 }, (_, i) => ({
    id: nid(),
    number: `INV-${i}`,
    date: "2026-07-01",
    partyId: "p1",
    partyName: "p1",
    lineItems: [],
    subtotal: 1000,
    discount: 0,
    taxAmount: 0,
    total: 1000,
    paid: 0,
    paymentMode: "credit",
    createdAt: "",
  }));
  const initialPaid = new Map(invoices.map((i) => [i.id, 0]));
  const payments: Payment[] = [];

  const applyPayment = (): Payment | null => {
    const open = invoices.filter((i) => r2(i.total - i.paid) > 1);
    if (!open.length) return null;
    const allocs = open
      .slice(0, 1 + ri(3))
      .map((inv) => {
        const amt = r2(Math.min(r2(inv.total - inv.paid), 50 + rnd() * 400));
        inv.paid = r2(inv.paid + amt); // app behaviour
        return { invoiceId: inv.id, number: inv.number, amount: amt };
      })
      .filter((a) => a.amount > 0);
    if (!allocs.length) return null;
    const p: Payment = {
      id: nid(),
      date: "2026-07-02",
      partyId: "p1",
      partyName: "p1",
      type: "in",
      amount: r2(allocs.reduce((s, a) => s + a.amount, 0)),
      mode: "cash",
      allocations: allocs,
      createdAt: "",
    };
    payments.push(p);
    return p;
  };
  const reverse = (p: Payment) => {
    for (const a of p.allocations ?? []) {
      const inv = invoices.find((i) => i.id === a.invoiceId)!;
      inv.paid = r2(inv.paid - a.amount);
    }
  };

  for (let op = 0; op < 3000; op++) {
    const k = ri(3);
    if (k === 0) applyPayment();
    else if (k === 1 && payments.length) {
      // delete (app: reverse allocations, remove record)
      const idx = ri(payments.length);
      reverse(payments[idx]);
      payments.splice(idx, 1);
    } else if (k === 2 && payments.length) {
      // edit (app: reverse, re-apply fresh)
      const idx = ri(payments.length);
      reverse(payments[idx]);
      payments.splice(idx, 1);
      applyPayment();
    }
    // INVARIANT: invoice.paid == initialPaid + sum of surviving allocations
    const byInv = paidViaPayments(payments);
    for (const inv of invoices) {
      const expected = r2((initialPaid.get(inv.id) ?? 0) + (byInv.get(inv.id) ?? 0));
      assert(
        approx(inv.paid, expected),
        `T6 op${op}: ${inv.number} paid ${inv.paid} != ${expected}`,
      );
      assert(
        inv.paid >= -0.01 && inv.paid <= inv.total + 0.01,
        `T6 op${op}: paid out of range ${inv.paid}`,
      );
    }
  }
  // Party balance must equal total dues (no advances in this scenario)
  const bal = partyBalances(invoices, [], payments)[0];
  const dues = r2(invoices.reduce((s, i) => s + (i.total - i.paid), 0));
  assert(approx(bal.balance, dues), `T6: party balance ${bal.balance} != open dues ${dues}`);
}

/* ═══════ TEST 7: expenses & adjustments in cash ═══════ */
{
  const exp: Expense[] = [
    {
      id: nid(),
      date: "2026-07-01",
      category: "Tea",
      amount: 50,
      paymentMode: "cash",
      createdAt: "",
    },
  ];
  const adj: CashAdjustment[] = [
    { id: nid(), date: "2026-07-01", type: "add", amount: 500, createdAt: "" },
    { id: nid(), date: "2026-07-01", type: "reduce", amount: 120, createdAt: "" },
  ];
  const cash = netFlow(cashFlows([], [], exp, [], adj));
  assert(approx(cash, 500 - 120 - 50), `T7: cash ${cash} != 330`);
}

/* ═══ TEST 10: a bank-mode expense is NOT double-counted in bankFlows ═══
   A bank expense already moved the account's stored balance at save time;
   the Bank page / dashboard add bankFlows ON TOP of stored balances, so
   bankFlows must exclude anything carrying a bankId. A cash expense (no
   bankId) must still be counted in cashFlows. Regression guard for A1. */
{
  const bankExp: Expense[] = [
    {
      id: nid(),
      date: "2026-07-01",
      category: "Rent",
      amount: 5000,
      paymentMode: "bank",
      bankId: "bk1",
      createdAt: "",
    },
  ];
  const bankOut = netFlow(bankFlows([], [], bankExp, []));
  assert(bankOut === 0, `T10: bank expense must not appear in bankFlows (got ${bankOut})`);

  const cashExp: Expense[] = [
    {
      id: nid(),
      date: "2026-07-01",
      category: "Tea",
      amount: 50,
      paymentMode: "cash",
      createdAt: "",
    },
  ];
  const cashOut = netFlow(cashFlows([], [], cashExp, [], []));
  assert(cashOut === -50, `T10: cash expense must still count in cashFlows (got ${cashOut})`);
}

console.log(`\n══════════════════════════════════════`);

/* ═══ TEST 9: opening balance sign convention — never double counted ═══ */
{
  const partiesOB = [
    { id: "pA", name: "A", openingBalance: 5000 }, // they owe us
    { id: "pB", name: "B", openingBalance: -3000 }, // we owe them
  ];
  const cust = partyBalances([], [], [], partiesOB, "customer");
  const supp = partyBalances([], [], [], partiesOB, "supplier");
  const get = (list: ReturnType<typeof partyBalances>, id: string) =>
    list.find((b) => b.partyId === id)!.balance;
  assert(get(cust, "pA") === 5000, "T9: +opening must be receivable");
  assert(get(supp, "pA") === 0, "T9: +opening must NOT be payable");
  assert(get(cust, "pB") === 0, "T9: -opening must NOT be receivable");
  assert(get(supp, "pB") === 3000, "T9: -opening must be payable");
  const stmt = partyBalances([], [], [], partiesOB); // statement: signed as-is
  assert(get(stmt, "pA") === 5000 && get(stmt, "pB") === -3000, "T9: statement uses signed value");
}

/* ═══ TEST 8: Repository — empty-string draft IDs must be replaced ═══ */
{
  const repo = new Repository<{ id: string; total: number }>("test-collection");
  const a = repo.add({ id: "", total: 100 } as never);
  const b = repo.add({ id: "", total: 200 } as never);
  const c = repo.add({ total: 300 } as never);
  assert(a.id.length > 0, "T8: empty-string id not replaced");
  assert(b.id.length > 0 && b.id !== a.id, "T8: ids must be unique");
  assert(c.id.length > 0, "T8: missing id not generated");
  assert(repo.all().length === 3, "T8: cache count");
  repo.adjustField(a.id, "total", -30);
  assert(repo.get(a.id)!.total === 70, "T8: adjustField cache math");
  repo.remove(b.id);
  assert(repo.all().length === 2, "T8: remove");
}

/* ═══ TEST 11: a bill's bank snapshot excludes Payment-record money ═══
   Regression for the highest-severity bug found in the Aug-2026 review:
   InvoiceForm stored the WHOLE of invoice.paid as bankPaidAmount. Once a
   Payment record was allocated to the bill, invoice.paid included money that
   had arrived by another route (often cash) and had already moved on its own
   mode — so merely re-saving the bill credited the bank account with it a
   second time, inventing money that existed nowhere. The correct snapshot is
   the "direct portion": paid minus whatever Payment records supplied — the
   same formula modeFlows() uses for the cash side. */
{
  // The REAL function InvoiceForm.finalizeSave calls — not a copy of it, so
  // this test can't pass while production drifts.
  const bankSnapshot = (inv: Invoice, paid: number, payments: Payment[]) =>
    correctBankPaidAmount({ ...inv, paid } as Invoice, payments);

  const bank: BankAccount = {
    id: "B1",
    name: "HDFC",
    openingBalance: 0,
    balance: 0,
    createdAt: "",
  } as BankAccount;

  let sale = {
    id: "S1",
    number: "INV-9001",
    date: "2026-08-01",
    partyId: "P1",
    partyName: "Ramesh",
    gstEnabled: false,
    lineItems: [],
    subtotal: 1000,
    discount: 0,
    taxAmount: 0,
    total: 1000,
    paid: 400,
    paymentMode: "bank",
    bankId: "B1",
    bankPaidAmount: 400,
    createdAt: "2026-08-01T10:00:00Z",
  } as unknown as Invoice;
  bank.balance = 400; // moved at billing

  // A later CASH payment settles the rest and pushes invoice.paid to 1000.
  const pay = {
    id: "PY1",
    type: "in",
    date: "2026-08-05",
    partyId: "P1",
    partyName: "Ramesh",
    amount: 600,
    mode: "cash",
    allocations: [{ invoiceId: "S1", number: "INV-9001", amount: 600 }],
    createdAt: "2026-08-05T10:00:00Z",
  } as unknown as Payment;
  sale = { ...sale, paid: 1000 };

  const totalMoney = () =>
    r2(
      netFlow(cashFlows([sale], [], [], [pay], [])) +
        bank.balance +
        netFlow(bankFlows([sale], [], [], [pay])),
    );

  assert(totalMoney() === 1000, "T11: baseline — 400 bank + 600 cash");

  // Re-save the bill three times over. Each save reverses the stored snapshot
  // and applies the freshly computed one, exactly as finalizeSave does.
  for (let i = 0; i < 3; i++) {
    const next = bankSnapshot(sale, sale.paid, [pay]);
    bank.balance = r2(bank.balance - (sale.bankPaidAmount ?? 0) + (next ?? 0));
    sale = { ...sale, bankPaidAmount: next };
    assert(totalMoney() === 1000, `T11: re-save #${i + 1} must not create money`);
    assert(sale.bankPaidAmount === 400, `T11: re-save #${i + 1} keeps the direct portion`);
  }

  // The passbook derives from bankPaidAmount, so it must agree too.
  const passbook = buildBankLedger(bank, {
    sales: [sale],
    purchases: [],
    payments: [pay],
    bankTxns: [],
  }).fullBalance;
  assert(passbook === bank.balance, "T11: passbook must match the stored balance");

  // Reducing the bill to 800 leaves 600 payment-backed, so the bank keeps 200.
  const reduced = bankSnapshot(sale, 800, [pay]);
  bank.balance = r2(bank.balance - (sale.bankPaidAmount ?? 0) + (reduced ?? 0));
  sale = { ...sale, total: 800, paid: 800, bankPaidAmount: reduced };
  assert(reduced === 200, "T11: reduced bill keeps only its own direct portion");
  assert(totalMoney() === 800, "T11: reduced bill totals 800");

  // A non-bank bill must never carry a bank snapshot at all.
  const cashBill = { ...sale, paymentMode: "cash" } as Invoice;
  assert(
    bankSnapshot(cashBill, cashBill.paid, [pay]) === undefined,
    "T11: non-bank bill has no bank snapshot",
  );
}

/* ═══ TEST 12: profit excludes output GST ═══
   invoice.total is tax-INCLUSIVE while COGS is a tax-exclusive line cost, so
   the P&L and the dashboard were reporting the GST collected as earnings. */
{
  const gstBill = {
    id: "G1",
    total: 1180,
    taxAmount: 180,
    gstEnabled: true,
  } as unknown as Invoice;
  const plainBill = {
    id: "G2",
    total: 500,
    taxAmount: 0,
    gstEnabled: false,
  } as unknown as Invoice;
  // A legacy/imported doc marked non-GST but carrying a stale taxAmount must
  // NOT have that phantom tax stripped out of revenue.
  const legacyBill = {
    id: "G3",
    total: 300,
    taxAmount: 45,
    gstEnabled: false,
  } as unknown as Invoice;

  assert(valueExTax([gstBill]) === 1000, "T12: strips output GST");
  assert(valueExTax([plainBill]) === 500, "T12: non-GST bill untouched");
  assert(valueExTax([legacyBill]) === 300, "T12: gstEnabled:false ignores stale taxAmount");
  assert(valueExTax([gstBill, plainBill]) === 1500, "T12: sums correctly");
  assert(valueExTax([]) === 0, "T12: empty set");
  assert(
    valueExTax([{ total: 1180, taxAmount: 180 } as unknown as Invoice]) === 1000,
    "T12: undefined gstEnabled treated as GST bill",
  );
  // The invariant that actually matters: gross profit on a GST bill must equal
  // the ex-tax margin, never the tax-inflated one.
  const cogs = 700;
  assert(valueExTax([gstBill]) - cogs === 300, "T12: gross profit is ex-GST margin");
}

/* ═══ TEST 13: the bank reconciliation repair ═══
   Builds a book that HAS the historical corruption in it and checks the
   planner both spots it and lands the account on the derived truth. */
{
  const bank = {
    id: "BR1",
    name: "ICICI",
    openingBalance: 5000,
    balance: 99999, // deliberately wrong, as production is
    createdAt: "",
  } as unknown as BankAccount;

  const sale = {
    id: "RS1",
    number: "INV-7001",
    date: "2026-05-02",
    partyId: "P9",
    partyName: "Suresh",
    gstEnabled: false,
    lineItems: [],
    subtotal: 2000,
    discount: 0,
    taxAmount: 0,
    total: 2000,
    paid: 2000,
    paymentMode: "bank",
    bankId: "BR1",
    bankPaidAmount: 2000, // corrupted: 1500 of this came via a cash payment
    createdAt: "2026-05-02T09:00:00Z",
  } as unknown as Invoice;

  const pay = {
    id: "RP1",
    type: "in",
    date: "2026-05-09",
    partyId: "P9",
    partyName: "Suresh",
    amount: 1500,
    mode: "cash",
    allocations: [{ invoiceId: "RS1", number: "INV-7001", amount: 1500 }],
    createdAt: "2026-05-09T09:00:00Z",
  } as unknown as Payment;

  const plan = planBankRepair({
    sales: [sale],
    purchases: [],
    payments: [pay],
    banks: [bank],
    bankTxns: [],
    expenses: [],
  });

  assert(plan.hasWork, "T13: corruption must be detected");
  assert(plan.bills.length === 1, "T13: exactly one bill needs correcting");
  assert(plan.bills[0].stored === 2000, "T13: reports the stored snapshot");
  assert(plan.bills[0].correct === 500, "T13: only the direct portion is genuinely bank money");
  assert(plan.accounts.length === 1, "T13: the account balance is off");
  // opening 5000 + the bill's real 500 = 5500
  assert(plan.accounts[0].correct === 5500, "T13: balance re-derived from documents");
  assert(plan.accounts[0].delta === r2(5500 - 99999), "T13: delta is correct - stored");

  // Applying the plan and re-planning must find nothing left to do.
  const repairedSale = { ...sale, bankPaidAmount: plan.bills[0].correct } as Invoice;
  const repairedBank = { ...bank, balance: plan.accounts[0].correct } as BankAccount;
  const after = planBankRepair({
    sales: [repairedSale],
    purchases: [],
    payments: [pay],
    banks: [repairedBank],
    bankTxns: [],
    expenses: [],
  });
  assert(!after.hasWork, "T13: repair must be idempotent — nothing left on a second pass");

  // A healthy book must never be flagged (no spurious "corrections").
  const clean = planBankRepair({
    sales: [],
    purchases: [],
    payments: [],
    banks: [{ ...bank, balance: 5000 } as BankAccount],
    bankTxns: [],
    expenses: [],
  });
  assert(!clean.hasWork, "T13: a healthy book reports no work");

  // Cash-mode bills must be ignored entirely by the planner.
  const cashOnly = planBankRepair({
    sales: [{ ...sale, paymentMode: "cash", bankId: undefined } as Invoice],
    purchases: [],
    payments: [pay],
    banks: [{ ...bank, balance: 5000 } as BankAccount],
    bankTxns: [],
    expenses: [],
  });
  assert(cashOnly.bills.length === 0, "T13: non-bank bills are not touched");
}

/* ═══ TEST 14: settlement discount ═══
   The client's case: a 20,500 bill, 20,000 collected, the last 500 waived so
   the bill can be closed. The bill must read as fully settled and the party
   must owe nothing, while ONLY the 20,000 may ever appear as cash — the
   waived 500 is a cost, not money that arrived. */
{
  const inv = {
    id: "D1",
    number: "INV-5001",
    date: "2026-06-01",
    partyId: "PD",
    partyName: "Discount Co",
    gstEnabled: false,
    lineItems: [],
    subtotal: 20500,
    discount: 0,
    taxAmount: 0,
    total: 20500,
    paid: 20500, // 20000 cash + 500 written off
    paymentMode: "credit",
    createdAt: "2026-06-01T09:00:00Z",
  } as unknown as Invoice;

  const pay = {
    id: "DP1",
    type: "in",
    date: "2026-06-10",
    partyId: "PD",
    partyName: "Discount Co",
    amount: 20000, // cash only — the discount is NOT part of this
    mode: "cash",
    allocations: [{ invoiceId: "D1", number: "INV-5001", amount: 20000, discount: 500 }],
    createdAt: "2026-06-10T09:00:00Z",
  } as unknown as Payment;

  // The bill is settled in full: cash + write-off.
  assert(paidViaPayments([pay]).get("D1") === 20500, "T14: bill counted as fully settled");

  // The party owes nothing afterwards.
  const bal = partyBalances([inv], [], [pay], [{ id: "PD", name: "Discount Co" }], "customer");
  assert(bal[0].balance === 0, "T14: party balance clears to zero");

  // Only real cash reaches the cash position — never the written-off 500.
  const cash = netFlow(cashFlows([inv], [], [], [pay], []));
  assert(cash === 20000, `T14: cash must be 20000, got ${cash}`);

  // And the direct-portion formula must not invent a phantom receipt: the
  // invoice is "credit" mode, so nothing of it belongs in any mode's flows.
  const bankish = netFlow(bankFlows([inv], [], [], [pay]));
  assert(bankish === 0, "T14: no phantom bank movement");

  assert(totalSettlementDiscount([pay]) === 500, "T14: the write-off is reported for the P&L");
  assert(totalSettlementDiscount([]) === 0, "T14: no payments, no discount");

  // An advance must still be computed off CASH only, not cash + write-off.
  assert(advanceAmount(pay) === 0, "T14: fully applied, so no advance");
  const partial = {
    ...pay,
    amount: 20300,
    allocations: [{ invoiceId: "D1", number: "INV-5001", amount: 20000, discount: 500 }],
  } as unknown as Payment;
  assert(advanceAmount(partial) === 300, "T14: surplus cash is an advance; the write-off is not");
}

/* ═══ TEST 15: stock recomputed from its movements ═══
   Item.stock is a stored running total, so it CAN drift (a half-committed
   bill, a reversal that never landed). The repair rebuilds it from
   opening + purchases + sale returns − sales − purchase returns ± adjustments. */
{
  const item = {
    id: "SR_I1",
    name: "Widget",
    unit: "pcs",
    gstRate: 0,
    purchasePrice: 10,
    salePrice: 20,
    openingStock: 100,
    stock: 999, // deliberately wrong
    createdAt: "",
  } as unknown as Item;

  const line = (qty: number) => ({
    id: "l",
    itemId: "SR_I1",
    name: "Widget",
    unit: "pcs",
    qty,
    price: 10,
    discountPct: 0,
    gstRate: 0,
    amount: qty * 10,
  });
  const sale = { id: "s", lineItems: [line(30)] } as unknown as Invoice;
  const purchase = { id: "p", lineItems: [line(50)] } as unknown as Invoice;
  const saleRet = { id: "sr", lineItems: [line(5)] } as unknown as Return;
  const purRet = { id: "pr", lineItems: [line(2)] } as unknown as Return;
  const adjAdd = { id: "a1", itemId: "SR_I1", type: "add", qty: 7 } as never;
  const adjCut = { id: "a2", itemId: "SR_I1", type: "reduce", qty: 4 } as never;

  // 100 + 50 purchased + 5 returned in − 30 sold − 2 returned out + 7 − 4 = 126
  const plan = planStockRepair({
    items: [item],
    sales: [sale],
    purchases: [purchase],
    saleReturns: [saleRet],
    purchaseReturns: [purRet],
    stockAdjustments: [adjAdd, adjCut],
  });
  assert(plan.length === 1, "T15: drift detected");
  assert(plan[0].correct === 126, `T15: rebuilt stock should be 126, got ${plan[0]?.correct}`);
  assert(plan[0].stored === 999, "T15: reports what was stored");
  assert(plan[0].delta === 126 - 999, "T15: delta is correct − stored");

  // Applying it and re-planning must find nothing left.
  const fixed = { ...item, stock: plan[0].correct } as Item;
  const after = planStockRepair({
    items: [fixed],
    sales: [sale],
    purchases: [purchase],
    saleReturns: [saleRet],
    purchaseReturns: [purRet],
    stockAdjustments: [adjAdd, adjCut],
  });
  assert(after.length === 0, "T15: repair is idempotent");

  // A correct book must never be flagged.
  const clean = planStockRepair({
    items: [{ ...item, stock: 100 } as Item],
    sales: [],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    stockAdjustments: [],
  });
  assert(clean.length === 0, "T15: an untouched item reports no drift");
}

/* ═══ TEST 16: a party is never on BOTH sides at once ═══
   The real case from production: JAY MOBILE DABHOLI carried a 9,850 payable
   opening, then bought 11,000 of goods. Their statement said 1,150
   receivable; the dashboard said 9,850 payable AND 11,000 receivable,
   because the two sides were summed independently and never netted. */
{
  const party = { id: "JAY", name: "JAY MOBILE DABHOLI", openingBalance: -9850 };
  const sale = {
    id: "S",
    number: "0002",
    date: "2026-08-15",
    partyId: "JAY",
    partyName: "JAY MOBILE DABHOLI",
    gstEnabled: false,
    lineItems: [],
    subtotal: 11000,
    discount: 0,
    taxAmount: 0,
    total: 11000,
    paid: 0,
    paymentMode: "credit",
    createdAt: "2026-08-15T09:00:00Z",
  } as unknown as Invoice;

  const [pos] = netPartyPositions([party], {
    sales: [sale],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  assert(pos.net === 1150, `T16: net must be 1150 receivable, got ${pos.net}`);

  const receivable = Math.max(0, pos.net);
  const payable = Math.max(0, -pos.net);
  assert(receivable === 1150, "T16: appears in receivable");
  assert(payable === 0, "T16: and NOT in payable — never both");

  // A pure supplier still lands wholly on the payable side.
  const supplier = { id: "SUP", name: "Supplier", openingBalance: -9850 };
  const purchase = {
    id: "P",
    number: "PUR-1",
    date: "2026-08-15",
    partyId: "SUP",
    partyName: "Supplier",
    gstEnabled: false,
    lineItems: [],
    subtotal: 450,
    discount: 0,
    taxAmount: 0,
    total: 450,
    paid: 0,
    paymentMode: "credit",
    createdAt: "2026-08-15T09:00:00Z",
  } as unknown as Invoice;
  const [sp] = netPartyPositions([supplier], {
    sales: [],
    purchases: [purchase],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  assert(sp.net === -10300, `T16: supplier nets to -10300, got ${sp.net}`);

  // And the net must agree with what the party's own statement closes at —
  // the two disagreeing is exactly what the client reported.
  const stmt = buildPartyStatement(party, {
    sales: [sale],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  assert(
    Math.abs(stmt.fullBalance - pos.net) < 0.01,
    `T16: dashboard net (${pos.net}) must equal the statement's closing balance (${stmt.fullBalance})`,
  );

  // Paying a bill off moves the net, and an advance counts once.
  const paidSale = { ...sale, paid: 11000 } as Invoice;
  const [paidPos] = netPartyPositions([party], {
    sales: [paidSale],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  assert(paidPos.net === -9850, "T16: settling the bill leaves just the opening");
}

/* ═══ TEST 17: a stored figure that is not actually a number ═══════════
   Firestore is schemaless: TypeScript says Item.stock is a number, but a
   document can hold the STRING "5" — from an older import, a hand edit, a
   migration. Every screen renders it fine, so it stays invisible until an
   atomic adjustment touches it, and then the local cache and the cloud
   disagree PERMANENTLY:

     local  "5" + 15   → "515"  (JavaScript concatenates)
     cloud  increment  → 15     (Firestore treats a non-number as 0)

   which is how a bulk stock correction can look applied on one screen and
   wrong on the next. Subtraction is worse: "12" - 4 is NaN, stored as null.
   These pin the coercion in Repository.adjustBase. */
{
  const repo = new Repository<{ id: string; stock: number; balance?: number }>("test-adjust");
  const seed = (id: string, stock: unknown) =>
    repo.add({ id, stock } as unknown as { id: string; stock: number });

  seed("A", "5");
  assert(
    repo.adjustField("A", "stock", 15)?.stock === 20,
    "T17: string base adds (not concatenates)",
  );

  seed("B", "12");
  assert(repo.adjustField("B", "stock", -4)?.stock === 8, "T17: string base subtracts (not NaN)");

  seed("C", 5);
  assert(repo.adjustField("C", "stock", 15)?.stock === 20, "T17: a real number is unaffected");

  // A MISSING field keeps working the way Firestore's increment does: base 0.
  seed("D", undefined);
  assert(repo.adjustField("D", "stock", 7)?.stock === 7, "T17: a missing field bases at zero");

  // Junk that cannot be a number at all must not poison the record with NaN.
  seed("E", "abc");
  assert(repo.adjustField("E", "stock", 3)?.stock === 3, "T17: unparseable text bases at zero");

  // Rounding still applies through the coercion.
  seed("F", "2.005");
  assert(
    repo.adjustField("F", "stock", 0)?.stock === 2.01,
    "T17: coerced values still round to 2dp",
  );

  // Repeated adjustments must stay stable once healed.
  seed("G", "10");
  repo.adjustField("G", "stock", 5);
  assert(repo.adjustField("G", "stock", 5)?.stock === 20, "T17: the healed field keeps adding");
}

/* ═══ TEST 18: the repair planner must SEE a malformed stock ══════════
   A string "5" that happens to equal the correct figure produced a delta of
   zero, so Fix Calculations skipped it and the field stayed a string —
   waiting to corrupt itself on the next adjustment. It has to be reported so
   the repair rewrites it as a real number. */
{
  const mkItem = (id: string, stock: unknown, openingStock: unknown): Item =>
    ({
      id,
      name: `Item ${id}`,
      unit: "pcs",
      gstRate: 0,
      purchasePrice: 0,
      salePrice: 0,
      stock,
      openingStock,
      createdAt: "",
    }) as unknown as Item;
  const empty = {
    sales: [],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    stockAdjustments: [],
  };

  const rightValueWrongType = planStockRepair({ ...empty, items: [mkItem("X", "5", 5)] });
  assert(
    rightValueWrongType.length === 1 && rightValueWrongType[0].correct === 5,
    "T18: a string stock is reported even when it reads as the right number",
  );

  const genuinelyFine = planStockRepair({ ...empty, items: [mkItem("Y", 5, 5)] });
  assert(genuinelyFine.length === 0, "T18: a correct numeric stock is still left alone");

  // And the planner's own arithmetic must not concatenate string quantities.
  const withStringQty = planStockRepair({
    ...empty,
    items: [mkItem("Z", 10, 10)],
    stockAdjustments: [
      {
        id: "a1",
        itemId: "Z",
        itemName: "Item Z",
        date: "2026-01-01",
        type: "add",
        qty: "5",
        reason: "",
        createdAt: "",
      } as unknown as StockAdjustment,
    ],
  });
  assert(
    withStringQty.length === 1 && withStringQty[0].correct === 15,
    `T18: a string qty adds as 5, not "105" — got ${withStringQty[0]?.correct}`,
  );
}

/* ═══ TEST 20: one amount, spread oldest bill first ═══════════════════
   The counter takes a round figure off a customer's whole account; they do
   not think in invoices. spreadFifo turns that into allocations, and the
   rules it has to hold to are: oldest first (so an ageing report means
   something), cash before discount ON THE SAME BILL (so the everyday
   "20,000 and knock off the 500" closes it in one step), never settle more
   than a bill owes, and leave the remainder for the caller to record as an
   advance rather than losing it. */
{
  const sum = (a: { apply: number; discount: number }[], k: "apply" | "discount") =>
    Math.round(a.reduce((s, x) => s + x[k], 0) * 100) / 100;

  // The client's own example, as a single bill.
  const one = spreadFifo([20500], 20000, 500);
  assert(
    one[0].apply === 20000 && one[0].discount === 500,
    "T20: 20,000 + 500 off closes a 20,500 bill",
  );

  // Oldest first: the first bill closes before the second sees a rupee.
  const two = spreadFifo([10000, 10500], 15000, 0);
  assert(
    two[0].apply === 10000 && two[1].apply === 5000,
    `T20: the oldest bill is settled first — got ${JSON.stringify(two)}`,
  );

  // The discount follows the cash onto the bill the cash left short.
  const withDisc = spreadFifo([10000, 10500], 20000, 500);
  assert(
    withDisc[0].apply === 10000 &&
      withDisc[0].discount === 0 &&
      withDisc[1].apply === 10000 &&
      withDisc[1].discount === 500,
    `T20: the write-off closes the bill the cash fell short on — got ${JSON.stringify(withDisc)}`,
  );

  // Never over-settle: paying more than is owed leaves the surplus behind
  // for the caller to record as an advance.
  const over = spreadFifo([1000, 500], 5000, 0);
  assert(
    sum(over, "apply") === 1500,
    `T20: a bill is never over-settled — got ${sum(over, "apply")}`,
  );
  assert(
    over.every((r) => r.apply >= 0 && r.discount >= 0),
    "T20: no negative allocation",
  );

  // A discount bigger than the debt is not silently applied either.
  const bigDisc = spreadFifo([300], 0, 1000);
  assert(
    bigDisc[0].discount === 300,
    `T20: the write-off is capped at the due — got ${bigDisc[0].discount}`,
  );

  // Nothing to pay, nothing allocated.
  assert(
    spreadFifo([1000], 0, 0).every((r) => r.apply === 0 && r.discount === 0),
    "T20: zero pays nothing",
  );
  assert(spreadFifo([], 500, 0).length === 0, "T20: no bills, nothing to spread");

  // Negative or junk input must not create money.
  assert(spreadFifo([1000], -50, 0)[0].apply === 0, "T20: a negative amount pays nothing");
  assert(spreadFifo([-1000], 500, 0)[0].apply === 0, "T20: a negative due absorbs nothing");

  // Paise: three bills settled by a total that divides unevenly must still
  // add up to exactly what was handed over, with no drift.
  const paise = spreadFifo([33.33, 33.33, 33.34], 100, 0);
  assert(
    sum(paise, "apply") === 100,
    `T20: paise add back to the amount taken — got ${sum(paise, "apply")}`,
  );

  // Randomised: the invariants above must hold for any shape of account.
  let seed = 4242;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 2000; i++) {
    const dues = Array.from(
      { length: 1 + Math.floor(rnd() * 6) },
      () => Math.round(rnd() * 500000) / 100,
    );
    const cash = Math.round(rnd() * 600000) / 100;
    const disc = Math.round(rnd() * 20000) / 100;
    const out = spreadFifo(dues, cash, disc);
    const owed = Math.round(dues.reduce((s, d) => s + d, 0) * 100) / 100;
    assert(sum(out, "apply") <= cash + 0.005, "T20: never allocates more cash than was taken");
    assert(sum(out, "discount") <= disc + 0.005, "T20: never writes off more than allowed");
    assert(
      Math.round((sum(out, "apply") + sum(out, "discount")) * 100) / 100 <= owed + 0.005,
      "T20: never settles more than the account owes",
    );
    out.forEach((r, j) =>
      assert(
        Math.round((r.apply + r.discount) * 100) / 100 <= dues[j] + 0.005,
        "T20: never settles more than the bill owes",
      ),
    );
    // FIFO: a bill can only be partly settled if every bill before it is closed.
    for (let j = 1; j < out.length; j++) {
      const prevSettled = Math.round((out[j - 1].apply + out[j - 1].discount) * 100) / 100;
      if (out[j].apply + out[j].discount > 0.005) {
        assert(
          prevSettled >= dues[j - 1] - 0.005,
          "T20: no bill is skipped over an open older one",
        );
      }
    }
  }
}

/* ═══ TEST 21: a payment belongs on the day it happened ═══════════════
   The statement used to credit a bill's whole `paid` against the BILL's date,
   and then drop the payment row entirely whenever it had been fully applied.
   So money taken three weeks after a sale appeared on the sale's line, while
   an unapplied advance got a line of its own — the same act of taking money
   showing up in two different places depending on how it was allocated. That
   is the "sometimes up, sometimes at the bottom" the client reported.

   The split must be presentation only: the closing balance has to come out
   identical, which is what makes this safe to change on live books. */
{
  const party = { id: "LP", name: "Ledger Party", openingBalance: 0 };
  const bill = {
    id: "LB1",
    number: "INV-L1",
    date: "2026-03-01",
    partyId: "LP",
    partyName: "Ledger Party",
    lineItems: [],
    subtotal: 20500,
    discount: 0,
    shippingCharge: 0,
    taxAmount: 0,
    total: 20500,
    // 20,000 cash + a 500 write-off, both applied by the payment below.
    paid: 20500,
    paymentMode: "credit",
    createdAt: "2026-03-01T00:00:00Z",
  } as unknown as Invoice;
  const pay = {
    id: "LPAY",
    date: "2026-03-21",
    partyId: "LP",
    partyName: "Ledger Party",
    type: "in",
    amount: 20000,
    mode: "cash",
    allocations: [{ invoiceId: "LB1", number: "INV-L1", amount: 20000, discount: 500 }],
    createdAt: "2026-03-21T00:00:00Z",
  } as unknown as Payment;

  const { rows, fullBalance } = buildPartyStatement(party, {
    sales: [bill],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [pay],
  });

  const saleRow = rows.find((r) => r.ref === "INV-L1" && r.type === "Sale");
  assert(!!saleRow, "T21: the sale is on the statement");
  assert(
    saleRow?.receivedOrPaid === 0,
    `T21: the bill's own line shows only what was taken THAT DAY — got ${saleRow?.receivedOrPaid}`,
  );

  const payRow = rows.find((r) => r.type === "Payment Received");
  assert(!!payRow, "T21: a fully-applied payment still gets its own row");
  assert(
    payRow?.date === "2026-03-21" && payRow?.total === 20000,
    `T21: the payment sits on ITS date for the cash actually taken — got ${payRow?.date} / ${payRow?.total}`,
  );
  assert(
    payRow?.ref === "INV-L1",
    `T21: and says which bill it settled — got ${JSON.stringify(payRow?.ref)}`,
  );

  const discRow = rows.find((r) => r.type === "Discount Given");
  assert(!!discRow, "T21: the write-off is its own line, not silent");
  assert(
    discRow?.date === "2026-03-21" && discRow?.total === 500,
    `T21: the write-off is dated with the payment — got ${discRow?.date} / ${discRow?.total}`,
  );

  // The whole point: presentation changed, arithmetic did not.
  assert(fullBalance === 0, `T21: the bill is fully settled — closing ${fullBalance}`);
  const [netPos] = netPartyPositions([party], {
    sales: [bill],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [pay],
  });
  assert(
    Math.abs(netPos.net - fullBalance) < 0.01,
    `T21: the statement still agrees with the dashboard — ${netPos.net} vs ${fullBalance}`,
  );

  // Cash taken AT the counter still belongs on the bill's own date: it really
  // did happen then, and there is no payment record to carry it.
  const counterBill = { ...bill, id: "LB2", number: "INV-L2", paid: 400, total: 1000 } as Invoice;
  const counter = buildPartyStatement(party, {
    sales: [counterBill],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  const counterRow = counter.rows.find((r) => r.ref === "INV-L2");
  assert(
    counterRow?.receivedOrPaid === 400,
    `T21: money taken at billing stays on the bill's line — got ${counterRow?.receivedOrPaid}`,
  );
  assert(counter.fullBalance === 600, `T21: leaving 600 owed — got ${counter.fullBalance}`);

  // An advance that settles nothing keeps behaving as it always did.
  const advance = { ...pay, id: "LADV", amount: 300, allocations: undefined } as Payment;
  const withAdvance = buildPartyStatement(party, {
    sales: [],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [advance],
  });
  assert(
    withAdvance.fullBalance === -300,
    `T21: an unapplied advance still credits the party — got ${withAdvance.fullBalance}`,
  );
  assert(
    withAdvance.rows.filter((r) => r.type === "Payment Received").length === 1,
    "T21: and appears exactly once",
  );
}

/* ═══ TEST 22: recognising both legs of a transfer ════════════════════
   A transfer writes two records, one per account, and they have to be edited
   and deleted as one thing. Newer ones carry a shared id. OLDER ones do not,
   and they are the dangerous case: unrecognised, the Cash page treats the
   cash side as an ordinary manual entry and offers to EDIT it — which would
   move the cash and leave the bank account saying something else. The client
   was shown exactly that dialog. */
{
  const leg = (over: Partial<BankTxn>): BankTxn =>
    ({
      id: "bt" + Math.round((over.amount ?? 0) * 100),
      bankId: "B1",
      date: "2026-08-22",
      type: "deposit",
      amount: 2000,
      notes: "Transfer to K CASH — PIYUSH BHAI VALA",
      createdAt: "",
      ...over,
    }) as BankTxn;
  const cash = (over: Partial<CashAdjustment>): CashAdjustment =>
    ({
      id: "ca1",
      date: "2026-08-22",
      type: "reduce",
      amount: 2000,
      reason: "Transfer to K CASH — PIYUSH BHAI VALA",
      createdAt: "",
      ...over,
    }) as CashAdjustment;

  // The new way: a shared id, and nothing else needs to match.
  assert(
    transferLegsFor(cash({ transferId: "T1" }), [leg({ transferId: "T1", notes: "anything" })])
      .length === 1,
    "T22: a stamped pair is found by its id",
  );

  // The old way: same note, same date, same amount, opposite directions.
  assert(
    transferLegsFor(cash({}), [leg({})]).length === 1,
    "T22: an UNSTAMPED pair is still recognised by note + date + amount",
  );

  // Each of those four has to agree. Any one off and it is not a partner.
  assert(
    transferLegsFor(cash({}), [leg({ amount: 2001 })]).length === 0,
    "T22: a different amount is not the partner",
  );
  assert(
    transferLegsFor(cash({}), [leg({ date: "2026-08-23" })]).length === 0,
    "T22: a different date is not the partner",
  );
  assert(
    transferLegsFor(cash({}), [leg({ notes: "Transfer to somewhere else" })]).length === 0,
    "T22: a different note is not the partner",
  );
  // Direction: cash OUT pairs with money INTO a bank, never out of one.
  assert(
    transferLegsFor(cash({}), [leg({ type: "withdraw" })]).length === 0,
    "T22: both legs going the same way is not a transfer",
  );
  assert(
    transferLegsFor(cash({ type: "add" }), [leg({ type: "withdraw" })]).length === 1,
    "T22: cash IN pairs with money out of a bank",
  );

  // A manual entry that merely mentions a transfer stays editable — there is
  // no partner for it to fall out of step with.
  assert(
    transferLegsFor(cash({ reason: "Transfer to K CASH — PIYUSH BHAI VALA" }), []).length === 0,
    "T22: no partner found means it is an ordinary entry",
  );
  assert(
    transferLegsFor(cash({ reason: "Cash added, transferred from the shop till" }), [leg({})])
      .length === 0,
    "T22: a note that only mentions transferring is not a transfer leg",
  );
  assert(
    transferLegsFor(cash({ reason: undefined }), [leg({ notes: undefined })]).length === 0,
    "T22: an entry with no note is never paired by note",
  );
}

/* ═══ TEST S1: splits describe today's documents without changing them ══
   The seam has one job before anything can create a split: report, for every
   document that already exists, exactly the attribution the current readers
   compute. If it disagrees with them by a rupee, routing them through it
   moves money on screens the shop is using right now. */
{
  const cashBill = { paid: 1000, paymentMode: "cash" } as unknown as Invoice;
  assert(splitsOf(cashBill).length === 1, "S1: a cash bill is one row");
  assert(cashPart(cashBill) === 1000, "S1: and all of it is in the drawer");
  assert(bankParts(cashBill).size === 0, "S1: with no account involved");

  /* A bank bill reports bankPaidAmount, NOT paid. They differ whenever a
     receipt was allocated to this invoice afterwards, and the bank ledger has
     always used the smaller figure — reporting paid here would credit the
     account with money that arrived as a separate Payment. */
  const bankBill = {
    paid: 5000,
    paymentMode: "bank",
    bankId: "B1",
    bankPaidAmount: 3000,
  } as unknown as Invoice;
  assert(bankParts(bankBill).get("B1") === 3000, "S1: a bank bill reports what it attributed");
  assert(
    cashPart(bankBill) === 0,
    "S1: and nothing to cash — the rest of paid came from a Payment with its own mode",
  );

  // Credit is the absence of payment, not a way of paying.
  assert(
    splitsOf({ paid: 0, paymentMode: "credit" } as unknown as Invoice).length === 0,
    "S1: a credit bill attributes nothing",
  );
  assert(
    splitsOf({ paid: 0, paymentMode: "cash" } as unknown as Invoice).length === 0,
    "S1: nor does an unpaid one, whatever mode it names",
  );

  /* upi and cheque name no account. That is a pre-existing wart the daybook
     already buckets, and it must stay visible rather than being quietly
     credited to some account it never reached. */
  const upi = { paid: 700, paymentMode: "upi" } as unknown as Invoice;
  assert(bankParts(upi).size === 0, "S1: unassigned money is not credited to an account");
  assert(cashPart(upi) === 0, "S1: nor counted as cash");
  assert(unassignedPart(upi) === 700, "S1: it is reported as unassigned, which is the truth");

  // Payments and expenses use different field names for the same idea.
  assert(
    cashPart({ amount: 250, mode: "cash" } as unknown as Payment) === 250,
    "S1: a Payment reads the same way",
  );
  assert(
    bankParts({ amount: 400, paymentMode: "bank", bankId: "B2" } as unknown as Expense).get(
      "B2",
    ) === 400,
    "S1: and so does an Expense",
  );

  /* Money that reached the document LATER belongs to the Payment that
     brought it, which carries its own mode and is counted there. A legacy
     document reports its amount less that; stored rows are already the
     document's own portion and must not be reduced a second time. Getting
     either direction wrong is a wrong number on the Cash page. */
  assert(
    cashPart({ paid: 1000, paymentMode: "cash" } as unknown as Invoice, 400) === 600,
    "S1: a legacy row reports only what the document itself settled",
  );
  assert(
    cashPart({ paid: 1000, paymentMode: "cash" } as unknown as Invoice, 1000) === 0,
    "S1: and nothing at all once every rupee of it arrived later",
  );
  assert(
    bankParts(bankBill, 2000).get("B1") === 3000,
    "S1: a legacy bank row is already the at-billing snapshot, so it is NOT reduced again",
  );

  // Stored rows win, and are the only case with more than one.
  const split = {
    paid: 10000,
    paymentMode: "cash",
    paidSplits: [
      { mode: "cash", amount: 4000 },
      { mode: "bank", amount: 6000, bankId: "B1" },
    ],
  } as unknown as Invoice;
  assert(cashPart(split) === 4000, "S1: a split bill reports its cash row");
  assert(
    cashPart(split, 2500) === 4000,
    "S1: and stored rows are the document's own portion already — never reduced twice",
  );
  assert(bankParts(split).get("B1") === 6000, "S1: and its bank row");
  assert(
    cashPart(split) + (bankParts(split).get("B1") ?? 0) === split.paid,
    "S1: and together they are the whole of what was paid",
  );
}

/* ═══ TEST S2: a document may not disagree with itself ══════════════════ */
{
  const ok = [
    { mode: "cash", amount: 4000 },
    { mode: "bank", amount: 6000, bankId: "B1" },
  ] as PaymentSplit[];
  assert(splitProblems(ok, 10000).length === 0, "S2: rows that add up are accepted");
  assert(
    splitProblems(ok, 9500).some((p) => p.message.includes("add up")),
    "S2: rows that do not add up to the amount are refused, and say both figures",
  );
  /* No assertion about sub-paisa dust: splitProblems rounds BOTH sides to
     paise before comparing, so dust cannot reach the comparison at all and
     any test of the tolerance passes with the tolerance removed. The
     tolerance stays as belt-and-braces should the rounding ever go, but
     claiming it is covered would be claiming coverage that does not exist. */
  assert(
    splitProblems([{ mode: "bank", amount: 500 }] as PaymentSplit[], 500).some((p) =>
      p.message.includes("which account"),
    ),
    "S2: bank money must say which account it went to",
  );
  assert(
    splitProblems([{ mode: "cash", amount: 0 }] as PaymentSplit[], 0).some((p) =>
      p.message.includes("enter an amount"),
    ),
    "S2: a row with no amount is not a row",
  );
  assert(
    splitProblems([{ mode: "credit", amount: 100 }] as PaymentSplit[], 100).some((p) =>
      p.message.includes("credit"),
    ),
    "S2: credit is what is left unpaid, not a way of paying",
  );
  assert(splitProblems([], 1000).length === 0, "S2: no rows at all is a single-mode document");
}

/* ═══ TEST S3: a part-cash, part-bank bill reaches BOTH places ══════════
   The reported case: ₹10,000 taken as ₹4,000 cash and ₹6,000 into HDFC.

   The dangerous half is cash. modeFlows used to drop any bill that touched a
   bank, so the ₹6,000 was booked to HDFC correctly and the ₹4,000 simply
   stopped existing — which at the counter reads as the till being short
   rather than as a bug in a report. */
{
  const splitBill = {
    id: "SPL1",
    number: "INV-SPL",
    date: "2026-06-01",
    partyId: "P1",
    partyName: "A Customer",
    lineItems: [],
    total: 10000,
    paid: 10000,
    paymentMode: "cash",
    paidSplits: [
      { mode: "cash", amount: 4000 },
      { mode: "bank", amount: 6000, bankId: "B1" },
    ],
  } as unknown as Invoice;

  const cash = cashFlows([splitBill], [], [], [], []);
  assert(cash.length === 1, `S3: the bill reaches the cash page — ${cash.length} entries`);
  assert(
    netFlow(cash) === 4000,
    `S3: for the cash part only, not the whole bill and not nothing — ${netFlow(cash)}`,
  );

  // And the bank half is still the bank's, counted once.
  assert(
    bankParts(splitBill).get("B1") === 6000,
    "S3: the bank part is attributed to the account it went into",
  );
  assert(
    netFlow(modeFlows("bank", [splitBill], [], [], [])) === 0,
    "S3: and does NOT also appear in the bank-mode flows, which would double it",
  );
  assert(
    r2(netFlow(cash) + (bankParts(splitBill).get("B1") ?? 0)) === splitBill.paid,
    "S3: the two halves account for every rupee of what was paid, exactly once",
  );

  /* The bank half must reach the ACCOUNT's own ledger, not just the
     accessor. This is the mirror of the cash bug: read the account off the
     document's single bankId and a split bill — which has none — shows its
     cash correctly and its bank half nowhere at all. */
  {
    const bank = { id: "B1", name: "HDFC", openingBalance: 0 } as unknown as BankAccount;
    const led = buildBankLedger(bank, {
      sales: [splitBill],
      purchases: [],
      payments: [],
      bankTxns: [],
      expenses: [],
    });
    assert(
      led.rows.some((r) => r.credit === 6000),
      `S3: the account's own ledger shows the bank half — ${JSON.stringify(led.rows.map((r) => r.credit))}`,
    );
    assert(
      r2(led.fullBalance) === 6000,
      `S3: and its balance is that and no more — ${led.fullBalance}`,
    );
    const other = buildBankLedger({ ...bank, id: "B2" } as unknown as BankAccount, {
      sales: [splitBill],
      purchases: [],
      payments: [],
      bankTxns: [],
      expenses: [],
    });
    assert(
      r2(other.fullBalance) === 0,
      "S3: while an account the money never reached shows nothing",
    );
  }

  /* A purchase settled the same way takes money OUT of both. */
  const splitPurchase = {
    ...splitBill,
    id: "SPL2",
    number: "PUR-SPL",
  } as unknown as Invoice;
  assert(
    netFlow(cashFlows([], [splitPurchase], [], [], [])) === -4000,
    "S3: a purchase settled part-cash takes only the cash part out of the drawer",
  );

  /* An ordinary single-mode bill is unaffected — the whole point of the
     accessor is that nothing existing moved. */
  const plainCash = {
    ...splitBill,
    id: "SPL3",
    paidSplits: undefined,
    paid: 800,
    paymentMode: "cash",
  } as unknown as Invoice;
  assert(
    netFlow(cashFlows([plainCash], [], [], [], [])) === 800,
    "S3: a plain cash bill still counts in full",
  );
  const plainBank = {
    ...splitBill,
    id: "SPL4",
    paidSplits: undefined,
    paid: 900,
    paymentMode: "bank",
    bankId: "B1",
    bankPaidAmount: 900,
  } as unknown as Invoice;
  assert(
    netFlow(cashFlows([plainBank], [], [], [], [])) === 0,
    "S3: and a plain bank bill still contributes nothing to cash",
  );
}

/* ═══ TEST S4: how a document says it was paid ══════════════════════════
   A bill printing "Cash" when half of it went to a bank is the original
   complaint restated. Asserted on the exact string, because the printed page
   contains the total and every other figure too — "does the page mention
   ₹1,000" cannot tell a payment label from an invoice line. */
{
  const named = (id: string) => (id === "B1" ? "HDFC Current" : undefined);

  const one = { paid: 1000, paymentMode: "cash" } as unknown as Invoice;
  assert(
    describePayment(one, named) === "Cash",
    `S4: a single-mode bill says just the mode — "${describePayment(one, named)}"`,
  );

  const bank = {
    paid: 1000,
    paymentMode: "bank",
    bankId: "B1",
    bankPaidAmount: 1000,
  } as unknown as Invoice;
  assert(
    describePayment(bank, named) === "HDFC Current",
    `S4: and a bank one names the ACCOUNT rather than the word Bank — "${describePayment(bank, named)}"`,
  );
  assert(
    describePayment(bank) === "Bank",
    "S4: falling back to the mode when no name is available",
  );

  const split = {
    paid: 1000,
    paymentMode: "cash",
    paidSplits: [
      { mode: "cash", amount: 400 },
      { mode: "bank", amount: 600, bankId: "B1" },
    ],
  } as unknown as Invoice;
  assert(
    describePayment(split, named) === "Cash ₹400.00 + HDFC Current ₹600.00",
    `S4: a split says both parts and how much each was — "${describePayment(split, named)}"`,
  );

  assert(
    describePayment({ paid: 0, paymentMode: "credit" } as unknown as Invoice, named) === "Credit",
    "S4: a credit bill still reads as credit",
  );
  /* A new bill starts on Cash so that tabbing lands there, which means an
     unpaid bill can have the Cash pill lit. It is not a cash sale, and saying
     "Cash" on the customer's copy of a bill nobody paid is a small lie that
     becomes an argument later. */
  assert(
    describePayment({ paid: 0, paymentMode: "cash" } as unknown as Invoice, named) === "Unpaid",
    `S4: a bill with the Cash pill lit and nothing received reads as Unpaid — "${describePayment({ paid: 0, paymentMode: "cash" } as unknown as Invoice, named)}"`,
  );
  assert(
    describePayment({ paid: 0, paymentMode: "bank", bankId: "B1" } as unknown as Invoice, named) ===
      "Unpaid",
    "S4: and so does an unpaid one pointed at an account",
  );
}

/* ═══ TEST S5: a split reaches the account's own passbook ═══════════════
   Found by sweeping the rest of the app rather than by a failing test, and
   the worst of the lot. Step 5 moved the account's stored balance for a
   split receipt; the passbook still filtered on the document's bankId, which
   a split does not have. So the balance moved and the passbook did not show
   why — and bankRepair RE-DERIVES balances from exactly these entries, so the
   next repair would have "corrected" the balance back down and taken the
   money with it. */
{
  const bank = { id: "B1", name: "HDFC", openingBalance: 0 } as unknown as BankAccount;
  const splitReceipt = {
    id: "PS1",
    date: "2026-06-01",
    partyId: "P1",
    partyName: "A Customer",
    type: "in",
    amount: 1000,
    mode: "cash",
    splits: [
      { mode: "cash", amount: 400 },
      { mode: "bank", amount: 600, bankId: "B1" },
    ],
  } as unknown as Payment;
  const splitExpense = {
    id: "ES1",
    date: "2026-06-02",
    category: "Rent",
    amount: 500,
    paymentMode: "cash",
    splits: [
      { mode: "cash", amount: 200 },
      { mode: "bank", amount: 300, bankId: "B1" },
    ],
  } as unknown as Expense;

  const led = buildBankLedger(bank, {
    sales: [],
    purchases: [],
    payments: [splitReceipt],
    bankTxns: [],
    expenses: [splitExpense],
  });
  assert(
    led.rows.some((r) => r.credit === 600),
    `S5: a part-bank receipt shows in the passbook — ${JSON.stringify(led.rows.map((r) => [r.type, r.debit, r.credit]))}`,
  );
  assert(
    led.rows.some((r) => r.debit === 300),
    "S5: and so does a part-bank expense",
  );
  assert(
    r2(led.fullBalance) === 300,
    `S5: leaving the balance the passbook itself explains — 600 in, 300 out — ${led.fullBalance}`,
  );
  /* The property that makes the repair safe: what the passbook says and what
     the account holds must be the same number, or a repair "fixes" one of
     them into being wrong. */
  const cashSideOnly = cashPart(splitReceipt) - cashPart(splitExpense);
  assert(
    r2(cashSideOnly) === 200,
    `S5: and the cash halves stay in the drawer, not on the account — ${cashSideOnly}`,
  );
}

/* ═══ TEST S6: a split changes no NUMBER a party is shown ═══════════════
   Asked directly what "the party ledger is unaffected by design" means, and
   it deserves an assertion rather than a reading of the code — that same
   reasoning is what missed the passbook.

   The claim: a split decides which of the SHOP's accounts holds the money.
   It never changes what the party owes. So the same bill, settled the same
   total, must produce identical figures whether it was taken one way or two.
   If this ever fails, the split work is wrong.

   This compared whole rows byte-for-byte until the shop asked to be told
   which account each payment landed in — "which bank, cash, which — nothing
   mentioned anywhere". Rows now carry `settledBy` for exactly that, and it
   differs between a one-way and a split bill BECAUSE that is the difference
   being reported. So the comparison drops that one display-only field and
   keeps every figure, which is what the invariant was always about: the
   party's money, not the shop's filing. */
{
  const party = { id: "PX", openingBalance: 0 };
  const bill = (id: string, paidSplits?: unknown) =>
    ({
      id,
      number: "INV-" + id,
      date: "2026-06-01",
      partyId: "PX",
      partyName: "Someone",
      lineItems: [],
      total: 1000,
      paid: 1000,
      paymentMode: "cash",
      createdAt: "2026-06-01T09:00:00Z",
      ...(paidSplits ? { paidSplits } : {}),
    }) as unknown as Invoice;

  const oneWay = buildPartyStatement(party, {
    sales: [bill("A")],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  const twoWays = buildPartyStatement(party, {
    sales: [
      bill("A", [
        { mode: "cash", amount: 400 },
        { mode: "bank", amount: 600, bankId: "B1" },
      ]),
    ],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });

  assert(
    oneWay.fullBalance === twoWays.fullBalance,
    `S6: splitting a bill does not move the party's balance — ${oneWay.fullBalance} vs ${twoWays.fullBalance}`,
  );
  /** Everything except how the shop filed it. */
  const figuresOf = (rows: typeof oneWay.rows) =>
    JSON.stringify(rows.map(({ settledBy: _ignored, ...rest }) => rest));
  assert(
    figuresOf(oneWay.rows) === figuresOf(twoWays.rows),
    "S6: nor any figure on their statement — a split is about the shop's accounts, not the party",
  );
  /* And the new field is genuinely display-only: it is the ONLY difference
     between the two statements. Asserted so that a future change which
     smuggles a calculation into it fails here rather than quietly. */
  assert(
    JSON.stringify(oneWay.rows) !== JSON.stringify(twoWays.rows),
    "S6: while the split IS reported — the shop can see which account took it",
  );
  assert(
    twoWays.fullBalance === 0,
    `S6: and a bill paid in full leaves them owing nothing, however it was paid — ${twoWays.fullBalance}`,
  );
}

/* ═══ TEST S7: re-saving a split must not re-attribute the money ════════
   The bug this guards, found by asking whether the feature was really
   finished rather than by any test failing: the payment and expense dialogs
   never loaded an existing record's rows, so reopening a split showed it as
   single-mode. Saving then reversed the rows off their accounts and put the
   whole amount under one mode. The money did not vanish, which is worse —
   it moved somewhere nobody asked it to.

   Asserted on the property that makes a re-save safe: reversing what a
   document attributed and re-applying it must leave every account where it
   started. If the rows are lost in between, this stops being true. */
{
  const rows = [
    { mode: "cash", amount: 400 },
    { mode: "bank", amount: 600, bankId: "B1" },
  ] as PaymentSplit[];
  const saved = { amount: 1000, mode: "cash", splits: rows } as unknown as Payment;

  // What the dialog reloads, and what it would save back unchanged.
  const reloaded = saved.splits?.length ? saved.splits : null;
  assert(!!reloaded, "S7: reopening a split receipt finds its rows to show");

  const resaved = {
    amount: 1000,
    mode: reloaded ? largestSplitMode(reloaded) : "cash",
    splits: reloaded ?? undefined,
  } as unknown as Payment;

  const before = bankParts(saved);
  const after = bankParts(resaved);
  assert(
    (after.get("B1") ?? 0) === (before.get("B1") ?? 0),
    `S7: re-saving it untouched leaves the account exactly where it was — ${before.get("B1")} then ${after.get("B1")}`,
  );
  assert(
    cashPart(resaved) === cashPart(saved),
    "S7: and the drawer too, instead of swallowing the bank half",
  );

  /* The failure it replaces, stated so the assertion above cannot be read as
     trivia: a dialog that dropped the rows would re-save this as one mode. */
  const dropped = { amount: 1000, mode: "cash", splits: undefined } as unknown as Payment;
  assert(
    cashPart(dropped) === 1000 && (bankParts(dropped).get("B1") ?? 0) === 0,
    "S7: losing the rows would put the whole receipt in cash and empty the account",
  );
}

/* ═══════ TEST W: the WhatsApp link, said in a way a shop can act on ═══════
   The bridge reports three states and a shop needs six. Everything below is
   about the three it cannot report — and the two boundaries that decide
   whether the shop is told "wait" or "go and scan", which are the entire
   value of the feature and are trivially inverted. */
{
  const T0 = Date.parse("2026-09-09T10:00:00Z");
  const fresh = { everConnected: false };
  const used = { everConnected: true, lastConnectedAt: "2026-09-07T10:00:00Z" };

  /* ── Connected outranks everything, including a stale unsettled clock ── */
  assert(
    deriveLinkState({ status: "connected" }, { everConnected: true, unsettledSince: 0 }, T0) ===
      "connected",
    "W1: a live socket reads connected even if the fault clock was left running",
  );
  assert(linkSeverity("connected") === "ok", "W1: and it is the only green state");
  assert(
    linkSeverity("dropped") === "bad" &&
      linkSeverity("never_linked") === "bad" &&
      linkSeverity("unreachable") === "bad" &&
      linkSeverity("scan_needed") === "bad",
    "W1: every state that cannot send a bill shows red",
  );
  assert(
    linkSeverity("starting") === "busy",
    "W1: except a normal start, which must not train the shop to ignore red",
  );

  /* ── The grace period, at both sides of the line ────────────────────── */
  const waitingFor = (ms: number, h: { everConnected: boolean }) =>
    deriveLinkState({ status: "waiting" }, { ...h, unsettledSince: T0 - ms }, T0);

  assert(
    waitingFor(LINK_GRACE_MS - 1000, used) === "starting",
    "W2: one second inside the grace period is still just starting up",
  );
  assert(
    waitingFor(LINK_GRACE_MS + 1000, used) === "dropped",
    "W2: one second past it is a fault the shop is told about",
  );
  assert(
    deriveLinkState({ status: "waiting" }, { everConnected: true }, T0) === "starting",
    "W2: a first reading with no fault clock yet is treated as a start, not a fault",
  );

  /* ── The same wire response, opposite messages ──────────────────────── */
  assert(
    waitingFor(LINK_GRACE_MS + 1000, fresh) === "never_linked",
    "W3: identical bytes mean 'not set up' for a shop that never linked",
  );
  assert(
    waitingFor(LINK_GRACE_MS + 1000, used) === "dropped",
    "W3: and 'it broke' for one that had it working",
  );
  assert(
    linkHeadline("scan_needed", fresh) !== linkHeadline("scan_needed", used),
    "W3: a first link and a relink are not described with the same sentence",
  );

  /* ── A QR is an action, so it outranks the wait ─────────────────────── */
  assert(
    deriveLinkState({ status: "qr" }, { ...used, unsettledSince: T0 - 1000 }, T0) === "scan_needed",
    "W4: a QR one second old is offered immediately, not hidden behind the grace period",
  );

  /* ── An unreachable service is a different fault from a dead socket ─── */
  assert(
    deriveLinkState({ status: null }, { ...used, unsettledSince: T0 - 1000 }, T0) === "starting",
    "W5: one missed poll during a cold start does not go red",
  );
  assert(
    deriveLinkState({ status: null }, { ...used, unsettledSince: T0 - 60_000 }, T0) ===
      "unreachable",
    "W5: a service that keeps not answering is named as the service, not as WhatsApp",
  );
  assert(
    linkHeadline("unreachable", used) !== linkHeadline("dropped", used),
    "W5: because the two need different people to fix them",
  );

  /* ── Staff are never handed work only an owner can do ───────────────── */
  for (const st of ["scan_needed", "dropped", "never_linked", "unreachable"] as const) {
    assert(
      !/scan/i.test(linkAdvice(st, used, false)),
      "W6: staff are never told to scan a QR they will never be shown — " + st,
    );
    assert(
      needsScan(st) === (st !== "unreachable"),
      "W6: only a link fault is fixed by scanning; an unreachable service is not — " + st,
    );
  }
  assert(
    /owner/i.test(linkAdvice("dropped", used, false)),
    "W6: they are told who can fix it instead",
  );
  assert(
    /Linked Devices/i.test(linkAdvice("scan_needed", used, true)),
    "W6: while the owner gets the actual steps on the phone",
  );
  assert(
    !needsScan("connected") && !needsScan("starting"),
    "W6: and nothing is asked of anyone while it is working",
  );

  /* ── "since Tuesday" — the phrase that says how many bills went unsent ─ */
  const H = 3_600_000;
  assert(sinceLabel(undefined, T0) === undefined, "W7: a shop that never linked has no since");
  assert(
    sinceLabel(new Date(T0 - 30 * 60_000).toISOString(), T0) === "Last connected 30 minutes ago",
    "W7: minutes while it is still this shift",
  );
  assert(
    sinceLabel(new Date(T0 - 5 * H).toISOString(), T0) === "Last connected 5 hours ago",
    "W7: hours after that",
  );
  assert(
    sinceLabel(new Date(T0 - 50 * H).toISOString(), T0) === "Last connected 2 days ago",
    "W7: and days once it has been broken overnight",
  );
  assert(
    sinceLabel(new Date(T0 - 40 * 24 * H).toISOString(), T0) ===
      "Last connected more than a week ago",
    "W7: past a week it stops implying a precision this record does not have",
  );
  assert(
    sinceLabel(new Date(T0 + H).toISOString(), T0) === undefined,
    "W7: a clock skewed into the future says nothing rather than something absurd",
  );
}

/* ═══════ TEST W8: the QR must never reach a staff browser ═══════
   Read from the source rather than exercised, because the thing being
   protected is an absence — a field that must not be in a response — and the
   way it comes back is a refactor that "simplifies" the explicit field list
   into a spread. A test that renders a screen would not notice. */
{
  const src = readFileSync(process.cwd() + "/src/lib/whatsappAdmin.ts", "utf8");

  const staffAt = src.indexOf("export const getWhatsAppLinkStateServerFn");
  assert(
    staffAt !== -1,
    "W8: the staff-facing reader exists (renamed? this check just went blind)",
  );

  // To the end of that declaration, not to the end of the file.
  const after = src.slice(staffAt);
  const end = after.indexOf("\n  });");
  assert(end !== -1, "W8: its handler body could be delimited");
  const body = after.slice(0, end);

  assert(body.includes("requireActiveUser"), "W8: anyone who may send a bill may read the status");
  assert(
    !body.includes("requireOwner"),
    "W8: but it is not quietly narrowed back to owners, which would break the header for staff",
  );
  assert(
    !/\bqr\s*:/.test(body),
    "W8: and it never returns the QR itself — that code IS a login to the shop's WhatsApp",
  );
  assert(
    !/\.\.\.\s*\w+/.test(body),
    "W8: fields are listed one by one, so a new secret on the service stays behind by default",
  );

  const ownerAt = src.indexOf("export const getWhatsAppStatusServerFn");
  assert(ownerAt !== -1, "W8: the owner's reader is still there");
  const ownerBody = src.slice(ownerAt, ownerAt + src.slice(ownerAt).indexOf("\n  });"));
  assert(
    ownerBody.includes("requireOwner"),
    "W8: and it is the one that stayed owner-only, since it is the one carrying the QR",
  );
}

/* ═══════ TEST X: the outbox, and what it refuses to do on its own ═══════
   A queue that retries everything is not resilience — it is a machine for
   sending a customer two copies of the same invoice, and for keeping a bill
   that can never send in a red badge until the shop stops reading badges.
   Both refusals are asserted here. */
{
  const T0 = Date.parse("2026-09-09T10:00:00Z");
  const row = (over: Partial<OutboxItem> = {}): OutboxItem => ({
    id: "q1",
    label: "INV-0012",
    phone: "9876543210",
    message: "hi",
    fileName: "INV-0012.pdf",
    html: "<html></html>",
    landscape: false,
    queuedAt: new Date(T0 - 3_600_000).toISOString(),
    attempts: 0,
    auto: true,
    ...over,
  });

  /* ── Nothing that will fail forever goes in the queue ────────────────── */
  for (const m of [
    "This party has no phone number saved — add one to send via WhatsApp.",
    "Not signed in",
    "WhatsApp service isn't configured yet — set WHATSAPP_SERVICE_URL and ...",
    "Only the business owner can do this.",
    "Your account isn't active — ask the business owner to check your access.",
  ]) {
    assert(
      classifySendFailure(m, false) === "permanent",
      "X1: a fault in the request is never queued to retry forever — " + m.slice(0, 34),
    );
    assert(
      classifySendFailure(m, true) === "permanent",
      "X1: and the link's state does not change that — " + m.slice(0, 34),
    );
  }

  /* ── Only a failure we can prove is retried by itself ────────────────── */
  assert(
    classifySendFailure("Could not send WhatsApp message", false) === "offline",
    "X2: with the link already down, the message certainly did not go",
  );
  assert(
    classifySendFailure("Session not connected", true) === "offline",
    "X2: and the service saying so is just as good a proof",
  );
  assert(
    classifySendFailure("socket hang up", true) === "uncertain",
    "X3: but an unexplained failure on a live link might have sent — it is NOT offline",
  );
  assert(
    !isDue(row({ auto: false }), T0 + 86_400_000),
    "X3: and an uncertain one is never sent again by a timer, however long it waits",
  );
  assert(needsAttention(row({ auto: false })), "X3: it waits for a person instead, and says so");

  /* ── Backoff counts from the last attempt, not from queueing ─────────── */
  assert(
    retryDelayMs(0) < retryDelayMs(3) && retryDelayMs(3) < retryDelayMs(6),
    "X4: waits grow with each failure",
  );
  assert(retryDelayMs(99) === 1_800_000, "X4: and stop growing at half an hour");
  {
    const tried = row({ attempts: 3, lastAttemptAt: new Date(T0 - 1000).toISOString() });
    assert(
      !isDue(tried, T0),
      "X4: a row tried a second ago is not due again, however old the queue entry is",
    );
    assert(
      isDue({ ...tried, lastAttemptAt: new Date(T0 - retryDelayMs(3) - 1000).toISOString() }, T0),
      "X4: and is due once its own wait has passed",
    );
  }

  /* ── Two tills must not send the same bill twice ─────────────────────── */
  assert(
    !isDue(row({ sendingSince: T0 - 1000 }), T0),
    "X5: a row another tab is already sending is left alone",
  );
  assert(
    isDue(row({ sendingSince: T0 - CLAIM_STALE_MS - 1000 }), T0),
    "X5: unless that tab died holding it, or the row would be stuck forever",
  );

  /* ── Giving up hands over to a person; it never discards the bill ────── */
  assert(
    !isDue(row({ attempts: MAX_ATTEMPTS }), T0),
    "X6: after the last attempt the timer stops trying",
  );
  assert(
    needsAttention(row({ attempts: MAX_ATTEMPTS })),
    "X6: and the row is raised for a person rather than quietly dropped",
  );
  assert(
    !needsAttention(row({ attempts: MAX_ATTEMPTS - 1 })),
    "X6: while it still has attempts left, nobody is bothered",
  );

  /* ── The counter is told which of the two situations it is ───────────── */
  assert(
    queuedMessage("offline", "this invoice") !== queuedMessage("uncertain", "this invoice"),
    "X7: 'it will send itself' and 'check whether it sent' are not the same sentence",
  );
  assert(
    /queued|will send/i.test(queuedMessage("offline", "this invoice")),
    "X7: the offline one promises it will go",
  );
  assert(
    !/will send on its own/i.test(queuedMessage("uncertain", "this invoice")),
    "X7: the uncertain one promises nothing of the sort",
  );
}

/* ═══════ TEST Y: the two rules at the send seam ═══════
   Read from the source, because both are about ORDER and about an exception
   NOT being swallowed — neither shows up in the value a function returns, and
   both are exactly the kind of thing a later tidy-up inverts while every
   other test stays green. */
{
  const src = readFileSync(process.cwd() + "/src/lib/whatsappSend.ts", "utf8");

  /* ── The link is read BEFORE the attempt ───────────────────────────────
     A failed send drives the indicator red. Read it afterwards and the
     answer is always "it was down", so every unexplained failure would be
     filed as safe-to-retry — which is the machine for sending a customer a
     second copy of their invoice. */
  const readAt = src.indexOf('useWhatsAppLinkStore.getState().state === "connected"');
  const transmitAt = src.indexOf("await transmit(");
  assert(readAt !== -1, "Y1: the send path still reads the link state at all");
  assert(transmitAt !== -1, "Y1: and still transmits (renamed? this check just went blind)");
  assert(
    readAt < transmitAt,
    "Y1: it is read BEFORE the attempt, or every uncertain failure is misfiled as offline",
  );

  /* ── A fault in the request is never queued ──────────────────────────── */
  assert(
    /phase === "prepare"\)\s*throw/.test(src),
    "Y2: a prepare-phase failure is rethrown, not put in a queue that can only fail",
  );
  assert(/kind === "permanent"\)\s*throw/.test(src), "Y2: and so is anything classified permanent");

  /* ── Only a provable failure retries itself ──────────────────────────── */
  assert(
    /auto:\s*kind === "offline"/.test(src),
    "Y3: the queue only re-sends on its own what it can prove never went",
  );

  /* ── One bill, one id, across every attempt ───────────────────────────
     The service refuses a second send of an id it has already sent. That
     only protects anybody if a retry arrives under the SAME id — a fresh id
     per attempt is, from the service's side, simply a different bill, and
     the duplicate it exists to stop goes out anyway. Two halves, both
     needed, and both silently satisfiable-looking on their own. */
  const mintAt = src.indexOf("const clientMessageId =");
  assert(mintAt !== -1, "Y4: the send path mints an id for the bill");
  assert(
    mintAt < transmitAt,
    "Y4: before the first attempt, so the first send and its retries share it",
  );
  assert(
    /id:\s*clientMessageId,/.test(src),
    "Y4: and the queued row is stored under that very id, not a new one",
  );

  const queue = readFileSync(process.cwd() + "/src/store/whatsappOutbox.ts", "utf8");
  assert(
    /clientMessageId:\s*item\.id,/.test(queue),
    "Y4: which the queue then sends back as the id, closing the loop",
  );
}

/* ═══════ TEST Z: a service that answered is never called unreachable ═══════
   The bug this replaces was live for one deploy. A bridge responding in
   under half a second was shown to the shop as "Can't reach the WhatsApp
   service", because every failure — a rejected token, our own server
   erroring, the bridge genuinely being down — arrived as one exception and
   was rendered as the last of those. The fix is that the reader REPORTS an
   unreachable bridge rather than throwing, so a throw can only mean the call
   itself never got off the ground. Asserted from the source, because what
   matters is the shape of the contract rather than any one value. */
{
  const admin = readFileSync(process.cwd() + "/src/lib/whatsappAdmin.ts", "utf8");
  const at = admin.indexOf("export const getWhatsAppLinkStateServerFn");
  assert(at !== -1, "Z1: the staff-facing reader exists (renamed? this check just went blind)");
  const body = admin.slice(at, at + admin.slice(at).indexOf("\n  });"));

  assert(
    /reachable:\s*true/.test(body) && /reachable:\s*false/.test(body),
    "Z1: it answers whether the bridge replied, rather than leaving it to an exception",
  );
  assert(
    /catch\s*\(/.test(body),
    "Z1: a bridge that fails to answer is caught here, not thrown at the browser",
  );
  assert(
    /error:/.test(body),
    "Z1: and its actual words are handed back, so the screen can say what went wrong",
  );

  const store = readFileSync(process.cwd() + "/src/store/whatsappLink.ts", "utf8");
  assert(
    /lean\.reachable\s*\?/.test(store),
    "Z2: the store trusts that answer instead of inferring reachability from a throw",
  );
  assert(
    /askFailed\s*=\s*true/.test(store),
    "Z2: and a call that never got off the ground is recorded as OUR fault, separately",
  );
  assert(
    !/}\s*catch\s*{\s*reading\s*=\s*{\s*status:\s*null\s*};?\s*}/.test(store),
    "Z2: no bare catch quietly turning every fault into 'the service is down' again",
  );

  /* ── The Settings card must still be able to show a QR ────────────────
     Gating the code on being inside the header dialog meant an owner on the
     Settings page — where this shop has always scanned from — waited forever
     for a QR that was sitting on the service the whole time. */
  const ui = readFileSync(process.cwd() + "/src/components/WhatsAppLink.tsx", "utf8");
  assert(
    /useWatchWhileMounted\(isOwner\)/.test(ui),
    "Z3: any panel an owner is looking at asks for the QR, not only the dialog",
  );
  assert(
    /lastError/.test(ui),
    "Z3: and whatever went wrong is put on the screen rather than kept in a variable",
  );
}

/* ═══════ TEST M: a ledger says WHERE the money went, not only how much ═══
   The shop's report: "payment gone and received — which bank, cash, which —
   nothing mentioned anywhere". The statement held the answer the whole time
   and simply never carried it out of the builder. Asserted on values rather
   than on the rendering, because the rendering is the easy half. */
{
  const party = { id: "MP", openingBalance: 0 };
  const mk = (over: Record<string, unknown>) =>
    ({
      id: "MPAY1",
      createdAt: "2026-09-01T10:00:00Z",
      date: "2026-09-01",
      partyId: "MP",
      partyName: "Mode Party",
      type: "in",
      amount: 1000,
      ...over,
    }) as unknown as Payment;

  const bankPay = mk({ mode: "bank", bankId: "HDFC" });
  const st = buildPartyStatement(party, {
    sales: [],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [bankPay],
  });
  const row = st.rows.find((r) => r.type === "Payment Received");
  assert(!!row, "M1: the receipt has a row at all");
  assert(!!row?.settledBy, "M1: and that row carries the record the money moved through");
  assert(
    describePayment(row!.settledBy!, (id) => (id === "HDFC" ? "HDFC Current" : undefined)) ===
      "HDFC Current",
    "M1: which names the actual account, not the word 'Bank'",
  );

  /* A write-off moved no money. Labelling it with a mode would invent a
     payment that never happened — the one way this feature could lie. */
  const withDiscount = mk({
    id: "MPAY2",
    mode: "cash",
    amount: 0,
    allocations: [{ id: "X", number: "INV-1", amount: 0, discount: 250 }],
  });
  const st2 = buildPartyStatement(party, {
    sales: [],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [withDiscount],
  });
  const off = st2.rows.find((r) => r.type === "Discount Given");
  assert(!!off, "M2: the write-off has its own row");
  assert(!off?.settledBy, "M2: and carries no payment mode, because no money moved");

  /* An unpaid bill likewise: the pill highlighted on the form is not a
     payment, and printing it would be a small lie that becomes an argument. */
  const unpaid = {
    id: "MB1",
    createdAt: "2026-09-02T10:00:00Z",
    number: "INV-M1",
    date: "2026-09-02",
    partyId: "MP",
    partyName: "Mode Party",
    lineItems: [],
    total: 500,
    paid: 0,
    paymentMode: "cash",
  } as unknown as Invoice;
  const paidAtCounter = { ...unpaid, id: "MB2", number: "INV-M2", paid: 500 } as Invoice;
  const st3 = buildPartyStatement(party, {
    sales: [unpaid, paidAtCounter],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
  });
  assert(
    !st3.rows.find((r) => r.ref === "INV-M1")?.settledBy,
    "M3: an unpaid bill reports no mode, whatever pill was lit when it was written",
  );
  assert(
    !!st3.rows.find((r) => r.ref === "INV-M2")?.settledBy,
    "M3: while one settled at the counter does",
  );
}

/* ═══════ TEST P: a ledger PDF cannot be saved under the wrong name ═══════
   The bulk export walked TWO arrays with one index — the documents it had
   managed to render, and the parties it meant to name them after. Any party
   whose markup failed to mount was dropped from the first list only, and
   from there every remaining PDF was written under the previous party's
   name. The shop read that as "some came out full and some simple". What it
   actually was is one customer's account in a file named after another,
   which is the kind of thing that gets emailed onward.

   Read from the source because the failure is structural — two lists that
   must not be indexed independently — and a test that rendered one party
   would never see it. */
{
  const dlg = readFileSync(process.cwd() + "/src/components/PartyLedgerExportDialog.tsx", "utf8");

  assert(
    /docs\[i\]\.party\.name/.test(dlg),
    "P1: each PDF is named from the party carried WITH it",
  );
  assert(
    !/parties\[i\]\.name/.test(dlg),
    "P1: never from a second list walked with the same index",
  );
  assert(/party:\s*p,/.test(dlg), "P1: which means the party is pushed alongside its document");
  assert(
    /missed/.test(dlg),
    "P1: and a party whose document failed is reported, not silently dropped",
  );

  /* The bulk INVOICE export is the same shape and inherits the same trap,
     so it is held to the same rule. Checked here rather than on screen
     because the screen suite never downloads anything — a mutation that
     renamed the files from a second list survived every one of its
     assertions, which is exactly how the party version shipped broken. */
  const bulk = readFileSync(process.cwd() + "/src/components/InvoiceBulkExportDialog.tsx", "utf8");
  assert(
    /docs\[i\]\.inv\.number/.test(bulk),
    "P1: each bill's PDF is named from the bill carried WITH it",
  );
  assert(!/invoices\[i\]/.test(bulk), "P1: never from the selection list walked by the same index");
  assert(
    /inv,\s*el/.test(bulk) || /\{\s*inv,\s*el\s*\}/.test(bulk),
    "P1: which means the bill is pushed alongside its document",
  );

  /* The same trap one level down: the renderer hands back a plain array that
     callers pair positionally, so a short batch must fail rather than shift
     every later document onto the wrong name. */
  const pdf = readFileSync(process.cwd() + "/src/lib/pdf.ts", "utf8");
  assert(
    /pdfsBase64\.length !== slice\.length/.test(pdf),
    "P2: a batch that renders fewer PDFs than asked for throws instead of misaligning",
  );
}

/* ═══════ TEST K: the keyboard keeps its own cursor on screen ═══════
   The shop runs this from a MacBook with no mouse. On a 13" screen, tabbing
   into a field below the fold left the cursor somewhere invisible and the
   next thing typed went into a box nobody could see.

   Read from the source, and that is worth explaining rather than excusing.
   The behaviour lives in AppShell, and the screen suite — which renders real
   pages in a real browser — does NOT mount AppShell: a probe asserting
   document.querySelector("header") fails there. So nothing in the shell is
   covered by those 592 assertions, which is a gap worth knowing about well
   beyond this hook. Until that changes, the rules are pinned here, where
   they can at least not be deleted silently. */
{
  const hook = readFileSync(process.cwd() + "/src/hooks/useKeyboardFocusScroll.ts", "utf8");

  assert(/addEventListener\("focusin"/.test(hook), "K1: something watches where the focus lands");
  assert(
    /scrollIntoView\(\{\s*block:\s*"nearest"/.test(hook),
    "K1: and moves the least it can — anything stronger re-centres the page on every Tab",
  );

  /* The half that is easy to forget: a pointer must NOT scroll. A page that
     jumps under the hand that just clicked it is worse than one that never
     scrolls at all. */
  /* The SUBSCRIPTION, not the word. Matching "mousedown" anywhere passed
     happily when the listener was deleted and only its removeEventListener
     cleanup was left behind — found by mutation, which is the entire point
     of running one. */
  assert(
    /addEventListener\("mousedown", onPointer/.test(hook) &&
      /addEventListener\("touchstart", onPointer/.test(hook),
    "K2: a pointer cancels it, so clicking never yanks the page",
  );
  assert(
    /if \(!byKeyboard\) return;/.test(hook),
    "K2: enforced by a guard, not by hoping the events arrive in a helpful order",
  );

  /* Only keys that MOVE focus. Scrolling on a plain letter would fire in the
     middle of typing a party's name. */
  assert(
    /"Tab"/.test(hook) && /startsWith\("Arrow"\)/.test(hook),
    "K3: Tab and the arrows count as a focus move",
  );
  assert(!/e\.key\.length === 1/.test(hook), "K3: and a plain character is not treated as one");

  const shell = readFileSync(process.cwd() + "/src/components/layout/AppShell.tsx", "utf8");
  /* Commenting the call out left the name in the file, and a plain substring
     match called that mounted. It has to be a live statement. */
  assert(
    /^\s*useKeyboardFocusScroll\(\);\s*$/m.test(shell),
    "K4: the hook is actually mounted — app-wide, since every list page scrolls",
  );
}

/* ═══════ TEST D: an arrowed-to option is an option you can see ═══════
   Reported for "all dropdown selection": arrowing down walked the highlight
   straight past the bottom edge and kept going, invisibly. The shop arrows,
   sees nothing move, and presses Enter on something it cannot see — on a
   counter worked entirely by keyboard that is a wrong item on a bill, not a
   rough edge.

   Only the invoice form did this, with its own hand-rolled copy. It is one
   shared hook now, and every picker is held to using it. Listed by name on
   purpose: a new dropdown added later without it is the exact regression
   this is here to catch, and a count would quietly pass as they came and
   went. */
{
  const hook = readFileSync(process.cwd() + "/src/hooks/useHighlightScroll.ts", "utf8");
  assert(
    /scrollIntoView\(\{ block: "nearest" \}\)/.test(hook),
    "D1: the highlight is brought just into view, not re-centred on every keypress",
  );
  /* Without this it runs on every render and snaps a hand-scrolled list back
     to the highlight — which feels exactly like a list that cannot be
     scrolled, i.e. the complaint being fixed. */
  assert(
    /if \(prev\.current === index\) return;/.test(hook),
    "D1: and only when the highlight actually moved",
  );

  const wired = [
    "/src/components/SelectMenu.tsx",
    "/src/components/ComboInput.tsx",
    "/src/routes/payments.tsx",
    "/src/routes/expenses.tsx",
    "/src/components/ReturnForm.tsx",
    "/src/components/CashBankTransferDialog.tsx",
  ];

  /* The bill form is checked separately: its two item pickers carry their own
     older copies of this behaviour, so counting hooks against marked lists
     would not balance. What matters is the one that was missing — the
     customer picker, the single most-used dropdown in the app, which had no
     scroll handling of any kind while the bank and item pickers beside it
     did. That is how a shared hook gets written and a caller still gets
     forgotten. */
  /* The two money columns were asserted to be mutually exclusive, and that
     rule was WRONG — the shop found it. A bill settled at the counter moves
     the balance by nothing, so a 7,500 sale with 7,500 handed over rendered
     a completely blank row. Both movements belong on a bill's line.

     What replaces it is the property that actually has to hold, tested on
     values in TEST LC above: gave − got equals the net movement. All that is
     checked here is that both documents get their columns from the one place
     that enforces it, rather than each working it out again. */
  const stmt = readFileSync(process.cwd() + "/src/routes/parties_." + "$id.tsx", "utf8");
  const printable = readFileSync(
    process.cwd() + "/src/components/PrintablePartyStatement.tsx",
    "utf8",
  );
  for (const [name, src] of [
    ["the statement page", stmt],
    ["the printed statement", printable],
  ] as const) {
    assert(
      src.includes("ledgerColumns("),
      "D4: " + name + " takes its two columns from the shared rule",
    );
    assert(
      !src.includes("delta > 0 &&") && !src.includes("delta > 0.01 ?"),
      "D4: " + name + " no longer works the columns out from the net movement itself",
    );
  }

  const bill = readFileSync(process.cwd() + "/src/components/InvoiceForm.tsx", "utf8");
  assert(
    bill.includes("useHighlightScroll(partyListRef, partyIdx, partyOpen)"),
    "D3: the bill customer picker scrolls its highlight",
  );
  /* Counted, not merely present.

     A first version asked only whether each file mentioned the hook at all,
     and a file with TWO dropdowns passed happily after one of them lost its
     call — the other still matched. Found by mutation. Every marked list
     must have a hook call of its own, so the two counts have to agree. */
  for (const rel of wired) {
    const src = readFileSync(process.cwd() + rel, "utf8");
    const hooks = (src.match(/useHighlightScroll\([a-zA-Z]/g) ?? []).length;
    const lists = (src.match(/data-opt=\{/g) ?? []).length;
    assert(hooks > 0, "D2: this picker scrolls its highlight — " + rel);
    /* The hook finds the option by this attribute; without it the lookup
       silently returns nothing and the hook is decoration. */
    assert(lists > 0, "D2: and marks its options so the hook can find them — " + rel);
    assert(
      hooks === lists,
      `D2: every list in this file has a hook call of its own — ${rel}: ${hooks} hooks, ${lists} lists`,
    );
  }
}

/* ═══════ TEST B: a reopened bill form starts at the top ═══════
   Reported twice: open a new bill, scroll down, close it, open another, and
   it came back part-way down — customer card off the top, party field out of
   reach.

   Source-level, and for a reason worth writing down rather than hiding. The
   screen harness renders an 800x600 window, where an empty bill is not tall
   enough to scroll at all, so any assertion about its scroll position passes
   without testing anything — which is exactly what happened when I tried,
   and the check said so instead of going green. It also builds a fresh
   router per render, so it cannot reproduce the case that actually broke: a
   workspace tab whose component stays mounted while you work elsewhere.

   A test that cannot fail is worse than no test. What CAN be pinned is that
   the reset exists, happens more than once, and is keyed on more than first
   mount. Plain string checks rather than regexes, because the thing being
   matched is full of brackets and an escaping slip here fails silently. */
{
  const form = readFileSync(process.cwd() + "/src/components/InvoiceForm.tsx", "utf8");

  assert(form.includes("data-bill-scroll"), "B1: the form has a scrolling region of its own");
  assert(form.includes("el.scrollTop = 0;"), "B1: which is put back to the top");

  /* Once was not enough: the things that move a fresh form — data landing, a
     picker restoring, the router's own scroll handling — all happen after
     mount. */
  assert(
    form.includes("requestAnimationFrame(") && form.includes("}, 80);"),
    "B2: on the next frame and the next tick too, not only once on mount",
  );

  /* Keyed on the route, because reopening a bill in a workspace that keeps
     tabs alive is not a new mount. */
  assert(
    form.includes("[existing?.id, formPathname]"),
    "B3: and re-runs when the form is opened again, not only when it is built",
  );
}

/* ═══════ TEST PR: the printed statement behaves like paper ═══════
   The PDF is the very table that is on screen, so anything needing a mouse
   printed as nonsense. Three faults in one download:

     A folded breakdown printed the words "View details" and nothing else —
     an instruction the reader cannot carry out. The detail is always
     rendered now and merely hidden on screen while it is folded.

     The closing balance appeared on every page, because a browser repeats
     <tfoot> on each printed page of a table that breaks across pages.
     Repeating the column headers is exactly what you want; repeating the
     bottom line mid-statement is a second, contradictory total.

     And the rupee sign came out blank — the headless browser that draws
     these PDFs carries no font with it — so a column headed "You Gave (₹)"
     printed as "You Gave ( )". */
{
  const page = readFileSync(process.cwd() + "/src/routes/parties_." + "$id.tsx", "utf8");

  assert(
    page.includes("hidden print:table-row"),
    "PR1: a folded breakdown is hidden on screen but printed in full",
  );
  /* Matched on the control, not on its styling: the first version pinned an
     exact hover colour and broke the moment the row was restyled, which
     tells you nothing about whether the button still prints. */
  const foldButton = page.slice(page.indexOf("setOpen((v) => !v)"));
  assert(
    foldButton.slice(0, 400).includes("print:hidden"),
    "PR1: and the control that folds it never prints",
  );

  /* The closing balance lives in the body, so it prints once, at the end. */
  assert(
    !page.includes("<tfoot>"),
    "PR2: nothing sits in a tfoot, which a browser repeats on every printed page",
  );

  /* And a bottom line is never left alone on a fresh page. Moving it out of
     the tfoot stopped it REPEATING; this stops it arriving by itself under a
     full set of reprinted column headings, which reads as a second, empty
     statement. Both closing rows — the statement and the simple ledger —
     refuse a page break before them. */
  assert(
    (page.match(/breakBefore: "avoid"/g) ?? []).length >= 2,
    "PR4: neither closing row can be orphaned onto a page of its own",
  );

  assert(
    !page.includes("You Gave (\u20B9)"),
    "PR3: no column header leans on a glyph the PDF renderer cannot draw",
  );
}

/* ═══════ TEST SD: one ledger document, however it is downloaded ═══════
   Downloading one party's ledger built its PDF from the live table on the
   page; selecting several parties and downloading built theirs from
   PrintablePartyStatement. Two components rendering the same rows, so the
   two documents drifted apart — and the shop got a visibly different file
   depending on which button it pressed. Rebuilding the screen and forgetting
   the printable is exactly how that gap opened in the first place.

   Both go through the printable now. Asserted structurally, because the
   guarantee worth having is "there is only one of them", not "these two
   happen to match today". */
{
  const page = readFileSync(process.cwd() + "/src/routes/parties_." + "$id.tsx", "utf8");

  assert(
    page.includes("<PrintablePartyStatement"),
    "SD1: the party page renders the same printable the bulk export uses",
  );
  /* And points its PDFs at it. Rendering one and then exporting the screen
     anyway is a failure that looks exactly like success. */
  assert(
    page.includes('ledgerFormat === "simple" ? simpleLedgerRef.current : pdfRef.current'),
    "SD1: and every PDF is built from that, not from the screen",
  );

  /* The summary has to add up, or it is decoration. Opening + gave − got =
     closing: a party whose whole balance was an opening figure previously
     showed 0, 0, 0 and a closing balance of 5,100. */
  const printable = readFileSync(
    process.cwd() + "/src/components/PrintablePartyStatement.tsx",
    "utf8",
  );
  assert(
    printable.includes("Opening Balance") &&
      printable.includes("You Gave") &&
      printable.includes("You Got") &&
      printable.includes("Closing Balance"),
    "SD2: the summary carries the four figures that reconcile",
  );
  assert(
    !printable.includes('label: "Total Billed"'),
    "SD2: and not a fifth that takes part in no equation",
  );
}

/* ═══════ TEST NU: the WhatsApp nudge stays out of the way ═══════
   It opened across the Sales list while the counter was working, and the
   shop asked for it off those pages by name. What it reports is nearly
   always a configuration fault nobody at a till can fix — a wrong service
   URL, an expired key — so the red dot in the header carries it, and the
   dialog opens on a click when somebody actually wants it.

   In the audit suite because the nudge lives in AppShell, which the screen
   harness does not mount at all. */
{
  const ui = readFileSync(process.cwd() + "/src/components/WhatsAppLink.tsx", "utf8");
  /* Pulled out by string rather than by regex: the pattern being looked for
     is itself full of brackets and pipes, and an escaping slip in the search
     fails silently — it finds nothing and the check quietly passes. */
  const marker = 'const BUSY_ROUTE = new RegExp("';
  const at = ui.indexOf(marker);
  assert(at !== -1, "NU1: the nudge still has a list of places it must not appear");
  if (at !== -1) {
    const rest = ui.slice(at + marker.length);
    const re = new RegExp(rest.slice(0, rest.indexOf('"')));
    for (const path of ["/sales", "/purchase", "/sales/new", "/purchase/edit/abc"]) {
      assert(re.test(path), "NU1: it stays off " + path);
    }
    /* And still appears where there is nothing to interrupt, or it has
       simply been switched off rather than aimed. */
    for (const path of ["/", "/parties", "/settings"]) {
      assert(!re.test(path), "NU2: but it can still be shown on " + path);
    }
  }
}

/* ═══════ TEST LC: the two money columns always add up to the balance ═══
   The shop opened a party whose bills were all paid at the counter and saw
   a statement of blank rows: a 7,500 sale with 7,500 handed over moves the
   balance by nothing, and the columns were showing the movement. The money
   was in the ledger and invisible on it.

   A bill has two movements on one line — goods out, and whatever came back
   over the counter — and both belong on the row. The property that makes
   that safe is the one asserted here: whatever the two columns say, gave
   minus got must equal how far the balance actually moved. If that ever
   stops holding, the statement is telling the shop two different stories
   about the same rupees. */
{
  const check = (
    label: string,
    row: Record<string, unknown>,
    net: number,
    want: { gave: number; got: number },
  ) => {
    const c = ledgerColumns(row as never, net);
    assert(
      approx(c.gave, want.gave) && approx(c.got, want.got),
      "LC: " + label + " — got gave=" + c.gave + " got=" + c.got,
    );
    assert(
      approx(r2(c.gave - c.got), net),
      "LC: " + label + " reconciles — " + c.gave + " − " + c.got + " should be " + net,
    );
  };

  /* The case that was broken: nothing owed before, nothing owed after, and
     7,500 of trade on the line. */
  check("a sale settled in full at the counter", { docKind: "sale", total: 7500 }, 0, {
    gave: 7500,
    got: 7500,
  });
  check("a sale wholly on credit", { docKind: "sale", total: 300 }, 300, { gave: 300, got: 0 });
  check("a part-paid sale", { docKind: "sale", total: 1000 }, 600, { gave: 1000, got: 400 });

  /* Purchases mirror it: goods IN at full value, money out on the same line. */
  check("a purchase paid on the spot", { docKind: "purchase", total: 18000 }, 0, {
    gave: 18000,
    got: 18000,
  });
  check("a purchase on credit", { docKind: "purchase", total: 18000 }, -18000, {
    gave: 0,
    got: 18000,
  });

  /* One-directional rows stay one-directional. A return's stored settled
     figure equals its total for bookkeeping reasons, and reading that
     directly would invent a second movement. */
  check("a payment received", { type: "Payment Received", total: 2890 }, -2890, {
    gave: 0,
    got: 2890,
  });
  check("a payment made", { type: "Payment Made", total: 5000 }, 5000, { gave: 5000, got: 0 });
  check(
    "a sale return, whose settled figure mirrors its total",
    { docKind: "sale-return", total: 500, receivedOrPaid: 500 },
    -500,
    { gave: 0, got: 500 },
  );
  check("a write-off", { type: "Discount Given", total: 250 }, -250, { gave: 0, got: 250 });
}

/* ═══════ TEST SP: what a line starts at ═══════
   Two rules, both of which have already gone wrong in production.

   A sale line must start at the item selling price — not at this party own
   last price, which is how a picker showing 7,000 produced a line of 6,105.
   That preference was right while an item selling price was rewritten by
   whatever bill went out last; once that write was removed the selling price
   became the shop own decision, and history quietly overruling it is the
   shop being argued with by its records.

   And it must never fall back to the purchase price, which billed at cost
   with nothing on screen looking wrong.

   Source-level, and honestly so: the behavioural version of this passes
   whichever rule is in force, because the seeded item sells at 100 and has
   no differing history, so both mutations survive it. A test that cannot
   fail is not evidence. */
{
  const form = readFileSync(process.cwd() + "/src/components/InvoiceForm.tsx", "utf8");
  const want = "price: isSale ? (it.salePrice ?? 0) : (historicalPrice ?? it.purchasePrice),";
  const n = form.split(want).length - 1;
  assert(
    n === 2,
    "SP1: both places that build a line start a sale at the selling price — found " + n + " of 2",
  );
  assert(
    !form.includes("it.salePrice || it.purchasePrice"),
    "SP2: and no sale ever falls back to cost",
  );
}

/* ═══════ TEST LO: the total closes the entry, it does not open it ═══════
   A bill on paper lists what was bought and totals it underneath. The
   statement was doing the reverse — announcing "7 items · 17,790.00" and then
   showing the seven — which is an order you have to be taught to read. Every
   hand-written khata in the shop already works the other way round.

   Pinned at the source because document ORDER is the whole claim, and the two
   documents have to agree: the screen and the PDF are the same statement, and
   the shop has already been burnt once by them disagreeing. */
{
  const screen = readFileSync(process.cwd() + "/src/routes/parties_.$id.tsx", "utf8");
  const itemsAt = screen.indexOf("{hasDetail && (");
  const totalAt = screen.indexOf("onClick={onOpen}");
  assert(itemsAt > 0 && totalAt > 0, "LO1: the statement row still has both halves");
  assert(
    itemsAt < totalAt,
    "LO2: on screen the item lines come first and the total closes the entry",
  );

  const pdf = readFileSync(process.cwd() + "/src/components/PrintablePartyStatement.tsx", "utf8");
  const pItems = pdf.indexOf("{showBreakdown && (");
  const pTotal = pdf.indexOf(`{opening ? "" : fmtDate(r.date)}`);
  assert(pItems > 0 && pTotal > 0, "LO3: the printed statement still has both halves");
  assert(pItems < pTotal, "LO4: and the PDF prints them in that same order");

  /* A total torn onto the next page away from the lines it totals is the
     failure this order introduces, so both documents refuse that break. */
  assert(
    screen.includes(`breakBefore: hasDetail ? "avoid" : undefined`),
    "LO5: on screen a total is never broken away from its items",
  );
  assert(
    pdf.includes(`...(showBreakdown ? { pageBreakBefore: "avoid", breakBefore: "avoid" } : null)`),
    "LO6: nor in the PDF",
  );
}

/* ═══════ TEST PP: a dropdown that lands on the screen ═══════
   Photographed at the counter, on a phone: the item search dropdown opened
   with its prices hanging off the right edge of the display, and the
   last-prices popup lost its heading off the left. Both were anchored to an
   input inside a 720px-wide table on a 390px screen, and neither ever
   compared its answer to the width of the phone.

   The phone is the case every assertion here is built around, because the
   desk is the case that already worked. */
{
  const phone = { width: 390, height: 844 };
  /* An input sitting 140px into a table that is wider than the screen — so
     its right edge is already past the display. */
  const scrolledOff = { top: 300, bottom: 328, left: 140, right: 440, width: 300 };

  {
    const p = popupRect(scrolledOff, phone, { minWidth: 260 });
    assert(p.left >= 8, "PP1: a dropdown starts on the screen — left " + p.left);
    assert(p.left + p.width <= 390 - 8, "PP2: and ends on it — right edge " + (p.left + p.width));
    assert(p.width >= 260, "PP3: without being squeezed below readable — " + p.width);
  }

  /* Right-aligned, which is the one that walked off the LEFT: 256 subtracted
     from an input near the left gutter is a negative x. */
  {
    const nearLeft = { top: 300, bottom: 328, left: 12, right: 120, width: 108 };
    const p = popupRect(nearLeft, phone, { align: "right", preferredWidth: 256 });
    assert(p.left >= 8, "PP4: a right-aligned popup does not walk off the left — " + p.left);
    assert(p.left + p.width <= 382, "PP5: nor off the right — " + (p.left + p.width));
  }

  /* A panel may never be wider than the screen it has to fit on, however wide
     the thing it is anchored to. */
  {
    const wide = { top: 100, bottom: 130, left: 0, right: 700, width: 700 };
    const p = popupRect(wide, phone, { minWidth: 600 });
    assert(p.width <= 390 - 16, "PP6: never wider than the screen — " + p.width);
    assert(p.left >= 8 && p.left + p.width <= 382, "PP7: and still inside both gutters");
  }

  /* The keyboard, and the trap underneath it.
     A keyboard does not change the layout viewport at all — window.innerHeight
     is still 844 — it only covers the bottom of it. So the room below is
     measured against the visible band and the placement is measured against
     the layout box, and those are two different numbers that must not be
     swapped. */
  {
    const keyboardUp = { width: 390, height: 844, visibleTop: 0, visibleBottom: 400 };
    const low = { top: 330, bottom: 360, left: 20, right: 300, width: 280 };
    const p = popupRect(low, keyboardUp);
    assert(p.top === undefined, "PP8: with the keyboard over it, the list does not open downwards");
    /* The one that matters. `bottom` on a fixed element is measured from the
       bottom of the LAYOUT viewport, so this is the only value that puts the
       panel's lower edge against the input. Photographed failing: it was
       computed against the visible band instead and landed 220px above the
       box it belongs to, up beside the Bill Date field. */
    assert(
      p.bottom === 844 - (330 - 4),
      "PP9: it grows upward FROM the input — bottom " + p.bottom,
    );
    assert(
      844 - (p.bottom ?? 0) === 326,
      "PP10: whose lower edge is 4px above the input, not somewhere up the page",
    );
    assert(p.maxHeight > 0 && p.maxHeight <= 330, "PP11: within the room above it");
  }

  /* The exact reading that produced the photograph. At the moment a field is
     focused, iOS has already scrolled for the keyboard (offsetTop ≈ 217) but
     has not yet reported the shorter height, so visibleBottom comes back as
     1061 on an 844px phone. A bottom edge below the bottom of the screen is
     not a reading worth acting on: clamp it, and the answer is simply "there
     is room below", which there is. */
  {
    const stale = { width: 390, height: 844, visibleTop: 217, visibleBottom: 1061 };
    const box = { top: 330, bottom: 360, left: 20, right: 300, width: 280 };
    const p = popupRect(box, stale);
    assert(p.top === 364, "PP12: a viewport taller than the screen is not believed — top " + p.top);
    assert(
      (p.top ?? 0) + p.maxHeight <= 844,
      "PP13: and nothing is placed past the bottom of the real screen",
    );
  }

  /* And when there IS room below, it stays below — flipping a dropdown that
     had somewhere to go is its own kind of wrong. */
  {
    const high = { top: 100, bottom: 130, left: 20, right: 300, width: 280 };
    const p = popupRect(high, phone);
    assert(p.top === 134, "PP14: with room below, it hangs below the input — " + p.top);
    assert(p.bottom === undefined, "PP15: and is not bottom-anchored");
    assert(p.maxHeight <= 844 - 134, "PP16: never taller than the room it was given");
  }

  /* The desk, unchanged: a dropdown under a 200px input on a wide screen
     lines up with the input's own left edge and takes its own width. */
  {
    const desk = { width: 1440, height: 900 };
    const input = { top: 300, bottom: 328, left: 420, right: 620, width: 200 };
    const p = popupRect(input, desk);
    assert(p.left === 420, "PP17: on a desk it still lines up with its input");
    assert(p.width === 200, "PP18: at the input's own width");
    assert(p.top === 332, "PP19: just below it");
  }
}

/* ═══════ TEST WA: what the bridge now says, and what we do about it ═══════
   The bridge was rebuilt to answer honestly instead of optimistically, and
   every new sentence it can produce has to land in the right bucket here.
   Getting one wrong costs the shop a customer's trust in one direction or a
   duplicate invoice in the other. */
{
  /* A number that is not on WhatsApp. Before the bridge asked, this send
     "succeeded" into nothing — a landline or a mistyped digit swallowed a
     bill silently. It is a real answer about the number, so it must reach a
     person and must never sit in a retry queue: no amount of waiting makes a
     number exist. */
  assert(
    classifySendFailure(
      "919999999999 is not on WhatsApp — check the number saved for this party",
      true,
    ) === "permanent",
    "WA1: a number that is not on WhatsApp is never queued",
  );
  assert(
    classifySendFailure("919999999999 is not on WhatsApp — check the number", false) ===
      "permanent",
    "WA2: and stays permanent even when the app thought the link was down",
  );

  /* The two that must never be retried by a timer. Both can arrive while the
     app believes the link is down, which is exactly the path that used to
     classify them "offline" — safe to retry — when a message may already be
     on its way. */
  assert(
    classifySendFailure(
      "This message is already being sent — wait for that attempt to finish",
      false,
    ) === "uncertain",
    "WA3: a send already in flight is never auto-retried, link state notwithstanding",
  );
  assert(
    classifySendFailure(
      "The WhatsApp service didn't answer in time — the message may or may not have been sent.",
      false,
    ) === "uncertain",
    "WA4: nor is a request that timed out with no answer at all",
  );

  /* And the opposite mistake. A halted bridge reports through "not
     connected", which means nothing was handed over — so this one IS safe for
     the queue to retry on its own, and treating it as uncertain would leave
     the shop hand-sending every bill after a blip. */
  assert(
    classifySendFailure(
      "WhatsApp is not connected — this session was taken over by another connection",
      true,
    ) === "offline",
    "WA5: a session taken over means nothing was sent, so the queue may retry it",
  );
}

/* ═══════ TEST DV: the business's own paperwork ═════════════════════════
   Asked for by the business: somewhere to keep every business document —
   GST certificate, PAN, licences, insurance, signed contracts — name them,
   and get them back any time.

   The file goes to Storage and the record to Firestore; these are the rules
   that sit between the two, and each one is a decision about a vault the
   shop has to be able to trust. */
{
  const file = (name: string, size = 1024) => ({ name, size });

  /* ── What may be uploaded ──────────────────────────────────────────── */
  {
    assert(validateUpload(file("gst.pdf"), "GST Certificate", []).ok, "DV1: an ordinary upload");
    assert(
      !validateUpload(null, "GST Certificate", []).ok,
      "DV2: a name with no file is not an upload",
    );

    /* A vault whose entries are called "scan_004" is a folder, not a vault.
       The name is the whole point of the feature. */
    for (const blank of ["", "   "]) {
      const r = validateUpload(file("scan.pdf"), blank, []);
      assert(
        !r.ok && r.reason === "no-name",
        `DV3: a blank name is refused (${JSON.stringify(blank)})`,
      );
    }

    /* Two scans of the same certificate under one name is how a vault stops
       being trustworthy: nobody can tell which is current. Refused with the
       clashing name said back, so a person can rename or replace. */
    const dup = validateUpload(file("gst2.pdf"), "gst certificate", ["GST Certificate"]);
    assert(!dup.ok && dup.reason === "duplicate-name", "DV4: a duplicate name is refused");
    assert(
      !dup.ok && dup.message.includes("GST Certificate"),
      "DV5: and the message names the one already there — " + (dup.ok ? "" : dup.message),
    );

    /* Case and padding must not create a second "GST Certificate". */
    assert(
      !validateUpload(file("a.pdf"), "  GST CERTIFICATE  ", ["gst certificate"]).ok,
      "DV6: the clash check ignores case and padding",
    );

    const big = validateUpload(file("scan.pdf", MAX_DOC_BYTES + 1), "Drawing", []);
    assert(!big.ok && big.reason === "too-big", "DV7: a file over the limit is refused");
    assert(
      !big.ok && big.message.includes("MB"),
      "DV8: in megabytes, not bytes — " + (big.ok ? "" : big.message),
    );
    assert(
      validateUpload(file("scan.pdf", MAX_DOC_BYTES), "Drawing", []).ok,
      "DV9: and exactly the limit is still allowed",
    );
  }

  /* ── Where the bytes go ────────────────────────────────────────────────
     Keyed by the record's id, never by the name. Two documents may share a
     file name without either overwriting the other, and renaming a document
     later moves nothing — which is what makes rename a Firestore-only
     operation rather than a copy and a delete. */
  {
    const a = storagePathFor("id-1", "gst.pdf");
    const b = storagePathFor("id-2", "gst.pdf");
    assert(a !== b, "DV10: two documents with the same file name do not collide");
    assert(a.includes("id-1"), "DV11: the path is keyed by the record");
    assert(!a.includes("GST"), "DV12: and never by the name the shop chose, which can change");

    /* Storage treats these specially; a path carrying them is a path that
       cannot be fetched back. */
    const nasty = storagePathFor("id-3", "a#b?c[d]e*f/g\\h.pdf");
    assert(
      !/[#?[\]*\\]/.test(nasty) && nasty.split("/").length === 3,
      "DV13: characters Storage reserves are stripped out — " + nasty,
    );
    assert(
      storagePathFor("id-4", "").endsWith("/file"),
      "DV14: and an empty name still has a path",
    );
  }

  /* ── The name offered when a file is chosen ───────────────────────────
     A starting point, not a decision: the extension goes because the shop
     names the DOCUMENT and the file keeps its own name alongside. */
  {
    assert(suggestedName("GST Certificate.pdf") === "GST Certificate", "DV15: the extension goes");
    assert(
      suggestedName("IMG_20260921_114233.jpg") === "IMG 20260921 114233",
      "DV16: a camera's underscores become spaces — " + suggestedName("IMG_20260921_114233.jpg"),
    );
    assert(suggestedName("") === "", "DV17: and nothing in gives nothing out");
  }

  /* ── Finding one again ────────────────────────────────────────────────
     Every word has to match something, so two words narrow rather than
     widen — a vault where searching adds results is a vault nobody searches. */
  {
    const d = { name: "GST Certificate", fileName: "gst-2026.pdf", note: "Renewed Sept" };
    assert(docMatches("", d), "DV18: an empty search shows everything");
    assert(docMatches("gst", d), "DV19: by name");
    assert(docMatches("2026", d), "DV20: by file name");
    assert(docMatches("renewed", d), "DV21: by note");
    assert(docMatches("gst renewed", d), "DV22: and by words from more than one of them");
    assert(!docMatches("gst pan", d), "DV23: while a word that matches nothing excludes it");
  }

  /* ── Sizes a person reads ─────────────────────────────────────────────── */
  {
    assert(prettySize(512) === "512 B", "DV24: bytes");
    assert(prettySize(2048) === "2 KB", "DV25: kilobytes");
    assert(prettySize(5 * 1024 * 1024) === "5 MB", "DV26: megabytes");
    assert(prettySize(0) === "0 B", "DV27: and nothing is nothing, not NaN");
  }
}

/* ═══════ TEST RG: a new page has to be registered in three places ═══════
   Both bugs reported on the document vault were the same bug wearing two
   hats: the page existed, worked, and was in the sidebar — and was missing
   from a list somewhere else.

     · No tab opened for it. WorkspaceTabs decides from a path→title map, and
       a path it does not know returns null, so no tab is created and the
       page appears to be "outside" the app.
     · Uploads vanished on refresh. The write reached Firestore; nothing ever
       read it back. The owner's device subscribes to ALL_REPOS, which is
       derived from REPO_BY_KEY — and a repository missing from there has no
       listener, so its collection is empty in the cache forever.

   Source-level, deliberately. Both lists are plain object literals that a
   person edits by hand when adding a page, and the failure in both cases is
   silence: everything compiles, every test passes, and the page is simply
   empty or tab-less. A test that reads the lists is the only thing that
   notices. */
{
  const repos = readFileSync(process.cwd() + "/src/repositories/index.ts", "utf8");
  const tabs = readFileSync(process.cwd() + "/src/components/layout/WorkspaceTabs.tsx", "utf8");
  const sidebar = readFileSync(process.cwd() + "/src/components/layout/Sidebar.tsx", "utf8");

  /* ── Every collection the app writes is one the owner listens to ─────
     REPO_BY_KEY is also what a backup walks, so a repository missing from it
     is missing from the backup as well — the same omission costs the shop
     its data twice. */
  {
    const declared = [...repos.matchAll(/new Repository<[^>]*>\(\s*"([^"]+)"/g)].map((m) => m[1]);
    const sites = (repos.match(/new Repository\b/g) ?? []).length;
    assert(
      declared.length > 0 && declared.length === sites,
      `RG1: every Repository construction is readable — ${declared.length} of ${sites}`,
    );

    const keyBlock = repos.slice(
      repos.indexOf("export const REPO_BY_KEY"),
      repos.indexOf("const ALL_REPOS"),
    );
    assert(keyBlock.length > 100, "RG2: found the REPO_BY_KEY map");

    const missing = declared.filter((name) => !keyBlock.includes(`"bz.${name}"`));
    assert(
      missing.length === 0,
      "RG3: every collection is in REPO_BY_KEY, so the owner subscribes to it and a backup " +
        "contains it — missing: " +
        missing.join(", "),
    );
  }

  /* ── Every page in the sidebar opens a tab ────────────────────────────
     The sidebar is where a page is announced to the shop; the tab map is
     where it is announced to the shell. A page in one and not the other is
     a page that works and cannot be kept open. */
  {
    const navPaths = [...sidebar.matchAll(/path:\s*"(\/[^"]*)"/g)].map((m) => m[1]);
    assert(navPaths.length > 8, `RG4: read the sidebar's pages — found ${navPaths.length}`);

    const titleBlock = tabs.slice(
      tabs.indexOf("function titleFromPath"),
      tabs.indexOf("const ICON_BY_SEGMENT"),
    );
    assert(titleBlock.length > 100, "RG5: found the tab title map");

    // "/" is the dashboard and is handled before the map.
    const untitled = navPaths.filter((p) => p !== "/" && !titleBlock.includes(`"${p}":`));
    assert(
      untitled.length === 0,
      "RG6: every page in the sidebar has a tab title, or it opens no tab at all — " +
        untitled.join(", "),
    );
  }

  /* ── And the document vault specifically, since that is what was
         reported ─────────────────────────────────────────────────────── */
  {
    assert(repos.includes('"bz.business-docs"'), "RG7: the document vault survives a refresh");
    assert(
      tabs.includes('"/documents": "Documents"'),
      "RG8: and opens a tab like every other page",
    );
  }
}

/* ═══════ TEST GS: who the customer is, and which tax that means ════════
   A shop bills inside its own state and outside it in the same week. A supply inside the
   seller's own state carries CGST+SGST; one to another state carries IGST.
   Same total, two completely different invoices — and until now this app
   printed CGST+SGST on every bill it has ever produced.

   A note on the sample below. `27AAPFU0939F1ZV` is the GSTIN used as the
   worked example in GST's own documentation, and it is the ONLY one asserted
   here as known-good — three others written from memory failed, which is the
   correct outcome for invented numbers and is why they are not in this file.
   Everything else is tested as a PROPERTY, which needs no sample at all. */
{
  const GOOD = "27AAPFU0939F1ZV";

  /* ── Reading one ───────────────────────────────────────────────────── */
  {
    const v = readGstin(GOOD);
    assert(v.ok, "GS1: the documented example validates");
    assert(v.ok && v.stateCode === "27", "GS2: its first two characters are the state");
    assert(v.ok && v.state === "Maharashtra", "GS3: which has a name — " + (v.ok && v.state));
    assert(v.ok && v.pan === "AAPFU0939F", "GS4: and characters 3-12 are the holder's PAN");
    assert(readGstin("  27aapfu0939f1zv ").ok, "GS5: spacing and case are not the customer's job");
  }

  /* ── The checksum earns its place ─────────────────────────────────────
     A transposed digit is the commonest way a GSTIN is wrong and the hardest
     to catch by eye. Rather than trusting more samples, this asserts the
     property the check character exists for: no single-character change to a
     valid GSTIN may still read as valid. */
  {
    const ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const survived: string[] = [];
    for (let i = 0; i < GOOD.length; i += 1) {
      for (const c of ALPHA) {
        if (c === GOOD[i]) continue;
        const mutated = GOOD.slice(0, i) + c + GOOD.slice(i + 1);
        if (readGstin(mutated).ok) survived.push(mutated);
      }
    }
    assert(
      survived.length === 0,
      `GS6: no single mistyped character survives the check — ${survived.length} did, e.g. ${survived[0] ?? ""}`,
    );

    /* And a transposition, which a checksum weighted 1,2 is specifically
       there to catch. */
    const swapped = GOOD.slice(0, 5) + GOOD[6] + GOOD[5] + GOOD.slice(7);
    assert(swapped !== GOOD, "GS7: the transposition test actually changed something");
    assert(!readGstin(swapped).ok, "GS8: two swapped characters do not pass either");
  }

  /* ── And it says WHICH thing is wrong ─────────────────────────────────
     "Invalid GSTIN" tells the counter nothing. A wrong length is a paste that
     lost a character; a bad checksum is a typo; an unknown state code is
     usually the wrong first two digits entirely. */
  {
    const cases: [string, string][] = [
      ["", "empty"],
      ["27AAPFU0939F1Z", "length"],
      ["271APFU0939F1ZV", "shape"],
      ["99AAPFU0939F1ZV", "state"],
      ["27AAPFU0939F1ZA", "checksum"],
    ];
    for (const [input, problem] of cases) {
      const v = readGstin(input);
      assert(!v.ok && v.problem === problem, `GS9: "${input}" is reported as ${problem}`);
      assert(!v.ok && v.message.length > 12, `GS10: and in a sentence, not a code (${problem})`);
    }
  }

  /* ── The question that moves money ─────────────────────────────────── */
  {
    assert(supplyKind("24", "24") === "intra", "GS11: Gujarat to Gujarat is CGST+SGST");
    assert(supplyKind("24", "27") === "inter", "GS12: Gujarat to Maharashtra is IGST");

    /* The default that protects every bill written before today. Every party
       in the shop has no state recorded, and every bill so far has printed
       CGST+SGST — so an unknown state must keep doing exactly that rather
       than silently reclassifying a year of invoices. */
    assert(supplyKind(undefined, "27") === "intra", "GS13: an unknown seller state stays intra");
    assert(supplyKind("24", undefined) === "intra", "GS14: an unknown buyer state stays intra");
    assert(supplyKind("", "") === "intra", "GS15: and blanks are not interstate");
  }

  /* ── The split ────────────────────────────────────────────────────────
     The TOTAL is the one thing that must never move: this decides which
     columns it appears in, nothing more. */
  {
    const intra = splitTax(180, "intra");
    assert(intra.cgst === 90 && intra.sgst === 90, "GS16: intra-state halves the tax");
    assert(intra.igst === 0, "GS17: and carries no IGST");

    const inter = splitTax(180, "inter");
    assert(inter.igst === 180, "GS18: interstate is one IGST line at the full rate");
    assert(inter.cgst === 0 && inter.sgst === 0, "GS19: and no CGST or SGST");

    /* An odd paisa has to land somewhere. Half of 0.05 twice is 0.04, and a
       rupee that evaporates in the tax table is a rupee the return is out
       by. */
    const odd = splitTax(0.05, "intra");
    assert(
      odd.cgst + odd.sgst === 0.05,
      `GS20: an odd paisa is kept, not halved away — ${odd.cgst} + ${odd.sgst}`,
    );
    for (const amount of [0.01, 1.11, 45.55, 1234.57]) {
      const s = splitTax(amount, "intra");
      assert(
        Math.abs(s.cgst + s.sgst + s.igst - amount) < 0.005,
        `GS21: the total survives the split (${amount})`,
      );
    }
  }

  /* ── Reading a state off a half-typed GSTIN ─────────────────────────── */
  {
    assert(stateFromGstin("24")?.name === "Gujarat", "GS22: two digits are enough to name a state");
    assert(stateFromGstin("99") === undefined, "GS23: and a code that is not one names nothing");
    assert(stateFromGstin("") === undefined, "GS24: nor does nothing");
    assert(Object.keys(GST_STATES).length >= 36, "GS25: every state and union territory is listed");
  }
}

/* ═══════ TEST ES: the two papers before the tax invoice ════════════════
   The standard sequence, looked up rather than invented: enquiry → quotation
   → customer agrees → proforma invoice (often against an advance, and the
   thing a buyer's bank will accept) → goods go out → tax invoice.

   Everything asserted here is about what these documents must NOT do, because
   that is where the rules actually bite:

     · GST attaches to the tax invoice. Neither of these creates a liability
       and neither gives the buyer input credit.
     · Rule 46 wants the tax-invoice series consecutive and unique for the
       year. Nothing else may draw a number from it.
     · A proforma is not RELABELLED into a tax invoice. The heading is what
       makes a document legally what it is.

   Sources: CGST Rule 46; ClearTax and TaxAdda on the status of a proforma. */
{
  /* ── Neither posts, and neither moves goods ──────────────────────────
     Named constants rather than an absence. "The quotation screen happens
     not to call the stock code" is a fact about today's code; "a quotation
     moves no stock" is a fact about the business, and only the second is
     worth being able to break a test over. */
  {
    assert(ESTIMATE_MOVES_STOCK === false, "ES1: a quotation or proforma moves no stock");
    assert(ESTIMATE_POSTS_TO_LEDGER === false, "ES2: and posts nothing to the ledger");
  }

  /* ── The headings, which are what make them legally what they are ──── */
  {
    assert(estimateSpec("quotation").heading === "QUOTATION", "ES3: a quotation says so");
    assert(
      estimateSpec("proforma").heading === "PROFORMA INVOICE",
      "ES4: and a proforma says PROFORMA INVOICE — " + estimateSpec("proforma").heading,
    );
    /* Label a proforma "invoice" and it becomes one. So the word must not
       appear on its own anywhere in that heading. */
    assert(
      estimateSpec("proforma").heading !== "INVOICE" &&
        !/^TAX INVOICE/.test(estimateSpec("proforma").heading),
      "ES5: and is never headed as a tax invoice",
    );
    assert(
      /not a tax invoice/i.test(estimateSpec("proforma").disclaimer),
      "ES6: a proforma carries the line that says what it is not",
    );
    assert(
      /input tax credit/i.test(estimateSpec("proforma").disclaimer),
      "ES7: including that no credit may be claimed against it",
    );
    assert(
      estimateSpec("quotation").disclaimer === "",
      "ES8: a quotation needs no such line — nobody mistakes one for an invoice",
    );
  }

  /* ── Separate series, so the tax invoice's own is never holed ───────── */
  {
    const prefixes = { quotation: "QT-", proforma: "PI-" } as Record<EstimateKind, string>;
    assert(estimateSpec("quotation").prefix !== estimateSpec("proforma").prefix, "ES9: two series");
    assert(seriesOf("QT-0007", prefixes) === "quotation", "ES10: a QT number is a quotation's");
    assert(seriesOf("PI-0007", prefixes) === "proforma", "ES11: a PI number is a proforma's");
    assert(seriesOf("INV-0007", prefixes) === "invoice", "ES12: and INV belongs to the tax series");
    /* The consequence, stated as its own assertion: neither pre-sale series
       may be mistaken for the tax one, because a proforma holding an invoice
       number leaves a gap an auditor has to explain. */
    for (const k of ESTIMATE_KINDS) {
      assert(
        seriesOf(estimateSpec(k).prefix + "0001", prefixes) !== "invoice",
        `ES13: a ${k} number never reads as a tax invoice number`,
      );
    }
  }

  /* ── The chain, and where it ends ───────────────────────────────────── */
  {
    assert(estimateSpec("quotation").next === "proforma", "ES14: a quotation becomes a proforma");
    assert(
      estimateSpec("proforma").next === null,
      "ES15: and a proforma's next step is the tax invoice, which is not one of these",
    );
  }

  /* ── What may still be converted ────────────────────────────────────── */
  {
    assert(canConvertEstimate({ status: "open" }), "ES16: an open document converts");
    assert(!canConvertEstimate({ status: "converted" }), "ES17: one already converted does not");
    assert(!canConvertEstimate({ status: "cancelled" }), "ES18: nor a cancelled one");

    /* Expiry warns, it does not block. A quotation past its date is a price
       the shop may still choose to honour, with the customer standing there. */
    assert(isExpired({ validUntil: "2026-01-01" }, "2026-06-01"), "ES19: a past date is expired");
    assert(!isExpired({ validUntil: "2026-12-01" }, "2026-06-01"), "ES20: a future one is not");
    assert(!isExpired({}, "2026-06-01"), "ES21: and no date set never expires");
    assert(
      canConvertEstimate({ status: "open" }),
      "ES22: expiry is not a status — an expired quotation still converts",
    );
  }

  /* ── What carries forward, and what must not ─────────────────────────
     Everything describing the deal; nothing describing a payment. A proforma
     may well have collected an advance, but copying a `paid` figure onto the
     tax invoice marks it settled for money nobody received against it. */
  {
    const doc = {
      partyId: "P1",
      partyName: "Mumbai Fabricators",
      partyGstin: "27AAACC1234D1ZC",
      placeOfSupply: "27",
      gstEnabled: true,
      reverseCharge: true,
      lineItems: [{ id: "L", itemId: "I1", qty: 2 }],
      discount: 50,
      notes: "Ex-works",
      paid: 5000,
      paymentMode: "cash",
      number: "PI-0001",
      status: "open",
      id: "E1",
    } as unknown as Record<string, unknown>;

    const carried = carriedFields(doc);
    for (const k of [
      "partyId",
      "partyName",
      "partyGstin",
      "placeOfSupply",
      "lineItems",
      "discount",
      "notes",
    ]) {
      assert(carried[k] !== undefined, `ES23: ${k} carries forward`);
    }
    assert(carried.gstEnabled === true, "ES24: and whether it was a GST bill");
    assert(carried.reverseCharge === true, "ES25: and who owes the tax");

    assert(carried.paid === undefined, "ES26: an advance does NOT carry onto the tax invoice");
    assert(carried.paymentMode === undefined, "ES27: nor how it was taken");
    assert(carried.number === undefined, "ES28: and never the number — that is a new series");
    assert(carried.id === undefined, "ES29: nor the identity of the document it came from");
    assert(carried.status === undefined, "ES30: nor its status");
  }
}

/* ═══════ TEST EN: the series advance independently ═════════════════════
   A shop arriving from other software wants its own numbering, so the
   prefixes are editable. What must NOT be editable is the rule underneath:
   each series counts only its own documents. Rule 46 wants the tax-invoice
   series consecutive for the financial year, and the way that breaks is a
   quotation quietly taking the next invoice number. */
{
  EstimateRepo.add({
    id: "EN1",
    kind: "quotation",
    status: "open",
    number: "QT-0007",
    date: "2026-09-01",
    partyId: "P",
    partyName: "X",
    lineItems: [],
    subtotal: 0,
    discount: 0,
    taxAmount: 0,
    total: 0,
    createdAt: "2026-09-01T00:00:00Z",
  } as never);

  assert(
    nextEstimateNumber("QT-", "quotation") === "QT-0008",
    "EN1: a quotation follows the last quotation — " + nextEstimateNumber("QT-", "quotation"),
  );
  /* The one that matters: the proforma series has never been used, so it
     starts at 1 — it does NOT continue from the quotation that exists, and it
     certainly does not look at sales invoices. */
  assert(
    nextEstimateNumber("PI-", "proforma") === "PI-0001",
    "EN2: the proforma series starts on its own, not from the quotation's count — " +
      nextEstimateNumber("PI-", "proforma"),
  );

  EstimateRepo.add({
    id: "EN2",
    kind: "proforma",
    status: "open",
    number: "PI-0003",
    date: "2026-09-02",
    partyId: "P",
    partyName: "X",
    lineItems: [],
    subtotal: 0,
    discount: 0,
    taxAmount: 0,
    total: 0,
    createdAt: "2026-09-02T00:00:00Z",
  } as never);
  assert(nextEstimateNumber("PI-", "proforma") === "PI-0004", "EN3: and then follows its own");
  assert(
    nextEstimateNumber("QT-", "quotation") === "QT-0008",
    "EN4: while the quotation series is untouched by it",
  );

  /* A shop that renames its prefix keeps its count. The number is read off
     the trailing digits, not off the prefix, so changing QT- to EST- next
     April does not reissue numbers already sent to customers. */
  assert(
    nextEstimateNumber("EST/", "quotation") === "EST/0008",
    "EN5: renaming a prefix does not restart the count — " +
      nextEstimateNumber("EST/", "quotation"),
  );

  EstimateRepo.remove("EN1");
  EstimateRepo.remove("EN2");
}

/* ═══════ TEST AD: an advance against a proforma ════════════════════════
   A proforma is often what a shop sends to collect money before the goods
   move. The money is real; the document is not a bill. So the advance is an
   ordinary RECEIPT on the customer's account carrying a label saying which
   proforma prompted it — never an allocation, because there is nothing to
   allocate to. These assertions are about keeping those two ideas apart. */
{
  const pay = (over: Record<string, unknown>) =>
    ({ type: "in", amount: 1000, ...over }) as {
      type: "in" | "out";
      amount: number;
      againstEstimateId?: string;
    };

  const book = [
    pay({ againstEstimateId: "E1", amount: 5000 }),
    pay({ againstEstimateId: "E1", amount: 2500 }),
    pay({ againstEstimateId: "E2", amount: 9000 }),
    // An ordinary receipt against the same customer, tagged with nothing.
    pay({ amount: 400 }),
    // Money going the other way must never read as an advance received.
    pay({ type: "out", againstEstimateId: "E1", amount: 3000 }),
  ];

  assert(advanceAgainst("E1", book) === 7500, "AD1: advances against one proforma add up");
  assert(advanceAgainst("E2", book) === 9000, "AD2: and another's are its own");
  assert(advanceAgainst("E3", book) === 0, "AD3: a proforma with nothing against it has nothing");
  assert(
    advanceAgainst("", book) === 0,
    "AD4: and no document has nothing, rather than everything",
  );

  /* The two that would quietly overstate what a customer has paid. */
  assert(
    advanceAgainst("E1", book) !== 10500,
    "AD5: an untagged receipt is not counted against a proforma",
  );
  assert(advanceAgainst("E1", book) !== 4500, "AD6: nor is money paid OUT netted off what came in");

  /* What is still to come. */
  assert(balanceAfterAdvance(10000, 7500) === 2500, "AD7: the balance is what is left");
  assert(balanceAfterAdvance(10000, 0) === 10000, "AD8: with nothing in, all of it is left");
  /* Over-paid is nothing due, not negative due — the excess is an advance the
     customer's account already carries, and showing "−500 due" on a document
     invites somebody to refund it twice. */
  assert(
    balanceAfterAdvance(10000, 12000) === 0,
    "AD9: over-payment leaves nothing due, not less than nothing",
  );
}

/* ═══════ TEST EW: may this lorry leave? ════════════════════════════════
   A shop ships goods within its own state and across a border. A consignment
   over the threshold may not move without an e-way bill, and the penalty is
   ₹10,000 or the tax sought to be evaded, whichever is higher, plus the lorry
   held at the checkpoint.

   Every rule below was looked up, not remembered, and every one of them is a
   case somebody gets wrong. Sources: CGST Rules 138-138D, via ClearTax's
   e-way bill guide and the NIC portal. */
{
  const ask = (over: Partial<Parameters<typeof ewayRequired>[0]> = {}) =>
    ewayRequired({ consignmentValue: 10_000, supply: "intra", reason: "supply", ...over });

  /* ── The threshold, and the edge of it ──────────────────────────────── */
  {
    assert(!ask({ consignmentValue: 49_999, supply: "inter" }).required, "EW1: under 50,000, no");
    /* "Exceeding", not "reaching". A consignment of exactly ₹50,000 is under
       the limit — getting this backwards raises a bill nobody needed, which
       is the harmless direction, but it is still wrong. */
    assert(!ask({ consignmentValue: 50_000, supply: "inter" }).required, "EW2: exactly 50,000, no");
    assert(ask({ consignmentValue: 50_001, supply: "inter" }).required, "EW3: a rupee over, yes");

    /* The message has to be defensible at a checkpoint, so it says the
       figures rather than just "no". */
    const no = ask({ consignmentValue: 40_000, supply: "inter" });
    assert(/40,000/.test(no.because), "EW4: and says what the consignment was worth");
    assert(/50,000/.test(no.because), "EW5: and what the limit was");
  }

  /* ── The limit is per VEHICLE, not per invoice ───────────────────────
     Three invoices in one lorry are added. The function takes a consignment
     value for exactly this reason, and the "no" says so out loud, because
     this is the commonest way a shop is caught out honestly. */
  {
    const no = ask({ consignmentValue: 20_000, supply: "inter" });
    assert(
      /vehicle/i.test(no.because),
      "EW6: a 'no' warns that other invoices in the same lorry count too — " + no.because,
    );
  }

  /* ── States do not all use 50,000 ─────────────────────────────────────
     Intra-state limits run from ₹50,000 to ₹2,00,000, so the state's own
     figure is configuration. Interstate is fixed nationally and must NOT be
     movable by it. */
  {
    assert(
      !ask({ consignmentValue: 90_000, supply: "intra", intrastateThreshold: 1_00_000 }).required,
      "EW7: ₹90,000 inside a state whose limit is ₹1,00,000 needs none",
    );
    assert(
      ask({ consignmentValue: 90_000, supply: "inter", intrastateThreshold: 1_00_000 }).required,
      "EW8: but the same load crossing a border does — the state figure is not the national one",
    );
    assert(
      ask({ consignmentValue: 60_000, supply: "intra" }).required,
      "EW9: and with no state figure set, ₹50,000 is assumed",
    );
  }

  /* ── Job work across a border: ANY value ──────────────────────────────
     The rule a fabricator breaks first. Two brackets sent out for
     galvanising are worth ₹4,000 and still need one. */
  {
    const tiny = ask({ consignmentValue: 4_000, supply: "inter", reason: "job-work" });
    assert(tiny.required, "EW10: job work between states needs one at any value");
    assert(
      /whatever it is worth|any value/i.test(tiny.because),
      "EW11: and says that the threshold is not the point — " + tiny.because,
    );
    assert(
      ask({ consignmentValue: 4_000, supply: "inter", reason: "job-work-return" }).required,
      "EW12: and so does the return leg",
    );
    /* Inside one state it is an ordinary threshold question again. */
    assert(
      !ask({ consignmentValue: 4_000, supply: "intra", reason: "job-work" }).required,
      "EW13: while job work inside one state follows the state's limit",
    );
  }

  /* ── The eleven exemptions beat everything ───────────────────────────── */
  {
    const exempt = ask({
      consignmentValue: 5_00_000,
      supply: "inter",
      exemption: "non-motorised",
    });
    assert(!exempt.required, "EW14: an exempt movement needs none however valuable");
    assert(exempt.because.length > 10, "EW15: and says WHICH exemption — " + exempt.because);
    assert(
      Object.keys(EXEMPTION_LABELS).length === 11,
      "EW16: all eleven exemptions are listed, not a convenient few",
    );
  }

  /* ── How long it is good for ──────────────────────────────────────────
     One day per 200 km bracket, counted from the first Part-B entry. The
     published worked example is 310 km = 2 days. */
  {
    assert(validityDays(1) === 1, "EW17: any distance is at least a day");
    assert(validityDays(200) === 1, "EW18: 200 km is one day");
    assert(validityDays(201) === 2, "EW19: and a kilometre more is two");
    assert(validityDays(310) === 2, "EW20: 310 km is two days — the published example");
    assert(validityDays(400) === 2, "EW21: 400 km is still two");
    assert(validityDays(401) === 3, "EW22: 401 is three");
    assert(validityDays(0) === 1, "EW23: and an unknown distance is not zero days");

    /* Over-dimensional cargo — a fabricated structure on a trailer is exactly
       this — moves at a tenth of the allowance. */
    assert(validityDays(20, "odc") === 1, "EW24: 20 km of ODC is one day");
    assert(validityDays(25, "odc") === 2, "EW25: 25 km of ODC is two — not one");
    assert(
      validityDays(200, "odc") === 10,
      "EW26: and 200 km of ODC is ten days, not one — " + validityDays(200, "odc"),
    );
  }

  /* ── When the vehicle number may be left off ─────────────────────────── */
  {
    assert(!partBRequired(30, "intra"), "EW27: a short hop inside one state may skip Part B");
    assert(partBRequired(50, "intra"), "EW28: at 50 km it is needed again");
    assert(
      partBRequired(10, "inter"),
      "EW29: and crossing a border always needs it, however short",
    );
  }

  /* ── A document too old to raise one against ─────────────────────────── */
  {
    assert(canRaiseFor("2026-09-01", "2026-09-20").ok, "EW30: a recent document is fine");
    const old = canRaiseFor("2026-01-01", "2026-09-20");
    assert(!old.ok, "EW31: one over 180 days old cannot have an e-way bill raised at all");
    assert(
      !old.ok && /180/.test(old.because),
      "EW32: and says so before the lorry is loaded — " + (old.ok ? "" : old.because),
    );
  }

  /* ── Whose job it is ──────────────────────────────────────────────────── */
  {
    assert(
      whoGenerates({ supplierRegistered: true, recipientRegistered: true }) === "supplier",
      "EW33: the supplier raises it where they are registered",
    );
    assert(
      whoGenerates({ supplierRegistered: false, recipientRegistered: true }) === "recipient",
      "EW34: otherwise the recipient",
    );
    assert(
      whoGenerates({ supplierRegistered: false, recipientRegistered: false }) === "transporter",
      "EW35: and failing both, the transporter",
    );
  }
}

console.log(`  AUDIT RESULT: ${passed} assertions passed, ${failed} failed`);
if (fails.length) {
  console.log(`\nFailures:`);
  fails.forEach((f) => console.log("  ✗ " + f));
  process.exit(1);
}
console.log(`  ✅ ALL INVARIANTS HELD`);
console.log(`══════════════════════════════════════\n`);
