/**
 * Financial statements audit — run from audit.test.ts.
 *
 * Three kinds of proof:
 *  1. HAND-WORKED books: small enough to compute on paper, every figure pinned.
 *  2. CROSS-CHECKS: the postings agree with the screens the shop already
 *     trusts (party statement, Cash on Hand, each bank passbook), on any date.
 *  3. RANDOMIZED books: hundreds of businesses mixing every document type,
 *     including the awkward ones (JV bill-settlements, settlement discounts,
 *     split payments, transfers, "increase" notes, price-only notes, GST off,
 *     production, unknown ledgers) — each must balance to the paisa, on many
 *     dates, with a trial balance whose two sides agree.
 */
import type {
  BankAccount,
  BankTxn,
  BsAccount,
  CashAdjustment,
  Expense,
  FinConfig,
  Invoice,
  Item,
  JournalVoucher,
  LineItem,
  Party,
  Payment,
  PaymentSplit,
  Production,
  Return,
  StockAdjustment,
} from "@/types";
import {
  buildPostings,
  balances,
  unbalancedDocs,
  ACC,
  paise,
  type BooksData,
} from "@/lib/postings";
import { stockSnapshots, averageCosts, type StockData } from "@/lib/stockValuation";
import { buildFinancials, wdvDepreciation, dayBefore } from "@/lib/financials";
import { buildPartyStatement, buildBankLedger, cashFlows } from "@/lib/ledger";

type Assert = (cond: boolean, msg: string) => void;

const r2 = (n: number) => Math.round(n * 100) / 100;

function emptyBooks(): BooksData & StockData {
  return {
    parties: [],
    banks: [],
    sales: [],
    purchases: [],
    saleReturns: [],
    purchaseReturns: [],
    payments: [],
    expenses: [],
    cashAdjustments: [],
    bankTxns: [],
    journalVouchers: [],
    items: [],
    stockAdjustments: [],
    productions: [],
  };
}

const finInput = (b: BooksData & StockData, accounts: BsAccount[] = [], config?: FinConfig) => ({
  books: buildPostings(b),
  stock: b,
  parties: b.parties,
  banks: b.banks,
  accounts,
  config,
});

export function runFinancialsAudit(assert: Assert) {
  handWorked(assert);
  valuation(assert);
  averageCost(assert);
  depreciation(assert);
  randomized(assert);
}

/* ═══ FS1: a small year, worked on paper ═════════════════════════════════
   Opening: customer owes 5,000; bank 20,000; 10 sofas at ₹8,000 (80,000).
   Opening capital = 5,000 + 20,000 + 80,000 = 1,05,000.
   During the year:
   - buy 5 sofas at ₹9,000 + 18% GST = 45,000 + 8,100 on credit
   - sell 8 sofas at ₹15,000 + 18% = 1,20,000 + 21,600; 50,000 into bank at
     billing, the rest on credit
   - customer pays 30,000 in cash, settling the bill with a 600 discount
   - rent 12,000 paid from the bank
   - owner draws 5,000 cash (cash adjustment)
   Stock, moving average: 10 @ 8,000 + 5 @ 9,000 = 1,25,000 / 15 = 8,333.33…;
   8 sold → 7 left = 58,333.33.
   Trading: sales 1,20,000 + closing 58,333.33 − opening 80,000 − purchases
   45,000 = gross profit 53,333.33.
   P&L: − rent 12,000 − discount 600 = net profit 40,733.33.
   Capital: 1,05,000 + 40,733.33 − 5,000 (unclassified withdrawal) = 1,40,733.33. */
function handWorked(assert: Assert) {
  const b = emptyBooks();
  const D = (m: number, d: number) =>
    `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  b.parties = [
    { id: "C", name: "Customer", type: "customer", openingBalance: 5000, createdAt: "" } as Party,
    { id: "S", name: "Supplier", type: "supplier", openingBalance: 0, createdAt: "" } as Party,
  ];
  b.banks = [
    { id: "B", name: "HDFC", openingBalance: 20000, balance: 0, createdAt: "" } as BankAccount,
  ];
  b.items = [
    {
      id: "SOFA",
      name: "Sofa",
      unit: "PCS",
      gstRate: 18,
      purchasePrice: 9000,
      salePrice: 15000,
      stock: 7,
      openingStock: 10,
      openingRate: 8000,
      kind: "finished",
      createdAt: "",
    } as Item,
  ];
  const line = (qty: number, price: number): LineItem =>
    ({
      id: "l",
      itemId: "SOFA",
      name: "Sofa",
      qty,
      unit: "PCS",
      price,
      discountPct: 0,
      gstRate: 18,
      amount: qty * price * 1.18,
    }) as LineItem;
  b.purchases = [
    {
      id: "P1",
      number: "P1",
      date: D(5, 1),
      partyId: "S",
      partyName: "Supplier",
      lineItems: [line(5, 9000)],
      subtotal: 45000,
      discount: 0,
      taxAmount: 8100,
      total: 53100,
      paid: 0,
      paymentMode: "credit",
      gstEnabled: true,
      createdAt: "1",
    } as Invoice,
  ];
  b.sales = [
    {
      id: "S1",
      number: "S1",
      date: D(6, 1),
      partyId: "C",
      partyName: "Customer",
      lineItems: [line(8, 15000)],
      subtotal: 120000,
      discount: 0,
      taxAmount: 21600,
      total: 141600,
      paid: 50000 + 30600,
      paymentMode: "bank",
      bankId: "B",
      bankPaidAmount: 50000,
      gstEnabled: true,
      createdAt: "2",
    } as Invoice,
  ];
  b.payments = [
    {
      id: "PAY",
      date: D(7, 1),
      partyId: "C",
      partyName: "Customer",
      type: "in",
      amount: 30000,
      mode: "cash",
      allocations: [{ invoiceId: "S1", number: "S1", amount: 30000, discount: 600 }],
      createdAt: "3",
    } as Payment,
  ];
  b.expenses = [
    {
      id: "E",
      date: D(8, 1),
      category: "Rent",
      amount: 12000,
      paymentMode: "bank",
      bankId: "B",
      createdAt: "4",
    } as Expense,
  ];
  b.cashAdjustments = [
    {
      id: "CA",
      date: D(9, 1),
      type: "reduce",
      amount: 5000,
      reason: "Owner took",
      createdAt: "5",
    } as CashAdjustment,
  ];

  const f = buildFinancials(finInput(b), "2026-04-01", "2027-03-31");
  assert(f.openingStock === 80000, `FS1: opening stock 80,000, got ${f.openingStock}`);
  assert(
    approx(f.closingStock, 58333.33),
    `FS2: closing stock 58,333.33 (7 at moving average), got ${f.closingStock}`,
  );
  assert(f.sales === 120000 && f.purchases === 45000, "FS3: sales and purchases ex-GST");
  assert(approx(f.grossProfit, 53333.33), `FS4: gross profit 53,333.33, got ${f.grossProfit}`);
  assert(approx(f.netProfit, 40733.33), `FS5: net profit 40,733.33, got ${f.netProfit}`);
  assert(f.capital.opening === 105000, `FS6: opening capital 1,05,000, got ${f.capital.opening}`);
  assert(
    f.capital.adjustments === -5000,
    `FS7: 5,000 taken out of the drawer, got ${f.capital.adjustments}`,
  );
  assert(
    approx(f.capital.closing, 140733.33),
    `FS8: closing capital 1,40,733.33, got ${f.capital.closing}`,
  );
  assert(f.difference === 0, `FS9: the balance sheet balances, difference ${f.difference}`);
  // GST: output 21,600 − input 8,100 = 13,500 payable.
  assert(
    f.gstPayable === 13500 && f.gstCredit === 0,
    `FS10: GST payable 13,500, got ${f.gstPayable}`,
  );
  // Customer: 5,000 + 1,41,600 − 50,000 − 30,000 − 600 = 66,000 owed.
  const c = f.debtors.find((d) => d.partyId === "C");
  assert(c?.amount === 66000, `FS11: customer owes 66,000, got ${c?.amount}`);
  const s = f.creditors.find((d) => d.partyId === "S");
  assert(s?.amount === 53100, `FS12: supplier is owed 53,100, got ${s?.amount}`);
  // Bank 20,000 + 50,000 − 12,000 = 58,000; cash 30,000 − 5,000 = 25,000.
  const bank = f.cashBank.find((l) => l.account === "bank:B");
  const cash = f.cashBank.find((l) => l.account === ACC.cash);
  assert(bank?.amount === 58000, `FS13: bank 58,000, got ${bank?.amount}`);
  assert(cash?.amount === 25000, `FS14: cash 25,000, got ${cash?.amount}`);
  const dr = r2(f.trial.reduce((n, t) => n + t.debit, 0));
  const cr = r2(f.trial.reduce((n, t) => n + t.credit, 0));
  assert(dr === cr, `FS15: trial balance agrees, Dr ${dr} vs Cr ${cr}`);

  /* The same book, classified: rent as a direct cost, and the drawer
     withdrawal recorded instead as a JV to "Drawings" — gross profit moves,
     net profit does not; drawings move out of "adjustments". */
  const jvBook = { ...b, cashAdjustments: [] as CashAdjustment[] };
  jvBook.journalVouchers = [
    {
      id: "JV",
      number: "JV1",
      date: D(9, 1),
      narration: "Owner took cash",
      createdAt: "6",
      lines: [
        { id: "1", kind: "ledger", refId: "Drawings", refName: "Drawings", debit: 5000, credit: 0 },
        { id: "2", kind: "cash", refName: "Cash", debit: 0, credit: 5000 },
      ],
    } as JournalVoucher,
  ];
  const accounts = [{ id: "A1", name: "Drawings", group: "drawings", createdAt: "" } as BsAccount];
  const config = { id: "config", expenseClass: { Rent: "direct" }, createdAt: "" } as FinConfig;
  const g = buildFinancials(finInput(jvBook, accounts, config), "2026-04-01", "2027-03-31");
  assert(
    approx(g.grossProfit, 41333.33),
    `FS16: rent as a direct cost lowers gross profit, got ${g.grossProfit}`,
  );
  assert(approx(g.netProfit, 40733.33), "FS17: but not net profit");
  assert(
    g.capital.drawings === 5000 && g.capital.adjustments === 0,
    "FS18: the JV shows as drawings",
  );
  assert(g.difference === 0, `FS19: still balances, difference ${g.difference}`);

  /* The next year opens with this year's closing capital. */
  const next = buildFinancials(finInput(b), "2027-04-01", "2028-03-31");
  assert(
    approx(next.capital.opening, 140733.33),
    `FS20: next year opens at last year's closing, got ${next.capital.opening}`,
  );
  assert(approx(next.openingStock, 58333.33), "FS21: and with last year's closing stock");
}

/* ═══ FS-V: moving weighted average ═══════════════════════════════════════ */
function valuation(assert: Assert) {
  const b = emptyBooks();
  b.items = [
    {
      id: "F",
      name: "Fabric",
      unit: "MTR",
      gstRate: 5,
      purchasePrice: 0,
      salePrice: 0,
      stock: 0,
      openingStock: 0,
      kind: "raw",
      createdAt: "",
    } as Item,
    {
      id: "S",
      name: "Sofa",
      unit: "PCS",
      gstRate: 18,
      purchasePrice: 0,
      salePrice: 0,
      stock: 0,
      openingStock: 0,
      kind: "finished",
      createdAt: "",
    } as Item,
  ];
  const pl = (id: string, date: string, qty: number, price: number, extra: Partial<Invoice> = {}) =>
    ({
      id,
      number: id,
      date,
      partyId: "X",
      partyName: "X",
      subtotal: 0,
      discount: 0,
      taxAmount: 0,
      total: 0,
      paid: 0,
      paymentMode: "credit",
      createdAt: date,
      lineItems: [
        {
          id: "l",
          itemId: "F",
          name: "F",
          qty,
          unit: "MTR",
          price,
          discountPct: 0,
          gstRate: 5,
          amount: 0,
        },
      ],
      ...extra,
    }) as Invoice;
  // 10 m at 100, then 10 m at 130 → average 115.
  b.purchases = [pl("P1", "2026-04-02", 10, 100), pl("P2", "2026-04-03", 10, 130)];
  let [s] = stockSnapshots(b, ["2026-04-03"]);
  assert(
    approx(s.items.find((i) => i.itemId === "F")!.rate, 115),
    "FSV1: average of 100 and 130 is 115",
  );
  // A bill-level discount of 10% of the line value lowers its cost: 10 m at 200
  // with a 200 discount on 2,000 → 180.
  b.purchases.push(pl("P3", "2026-04-04", 10, 200, { discount: 200 }));
  [s] = stockSnapshots(b, ["2026-04-04"]);
  // (2,300 + 1,800) / 30 = 136.67
  assert(
    approx(s.items.find((i) => i.itemId === "F")!.value, 4100),
    `FSV2: bill discount reduces cost, got ${s.items.find((i) => i.itemId === "F")!.value}`,
  );
  // Production: 12 m consumed at the average, plus 3,000 labour → 1 sofa.
  b.productions = [
    {
      id: "PR",
      date: "2026-04-05",
      createdAt: "x",
      finishedItemId: "S",
      qty: 1,
      additionalCost: 3000,
      components: [{ itemId: "F", itemName: "F", unit: "MTR", qty: 12, rate: 0, amount: 0 }],
    } as unknown as Production,
  ];
  [s] = stockSnapshots(b, ["2026-04-05"]);
  const avg = 4100 / 30;
  assert(
    approx(s.items.find((i) => i.itemId === "S")!.value, 12 * avg + 3000, 0.05),
    `FSV3: a sofa costs its fabric at average + labour, got ${s.items.find((i) => i.itemId === "S")!.value}`,
  );
  assert(approx(s.items.find((i) => i.itemId === "F")!.qty, 18), "FSV4: the fabric used is gone");
  assert(
    approx(s.total, 4100 + 3000, 0.05),
    "FSV5: making moves value from fabric into the sofa (plus labour), it does not invent it",
  );
  // Selling more than there is: value floors at zero, never negative.
  b.sales = [
    {
      ...pl("SL", "2026-04-06", 25, 300),
      lineItems: [
        {
          id: "l",
          itemId: "F",
          name: "F",
          qty: 25,
          unit: "MTR",
          price: 300,
          discountPct: 0,
          gstRate: 5,
          amount: 0,
        },
      ],
    } as Invoice,
  ];
  [s] = stockSnapshots(b, ["2026-04-06"]);
  const f = s.items.find((i) => i.itemId === "F")!;
  assert(
    f.qty === -7 && f.value === 0,
    `FSV6: oversold stock is worth 0, not negative (qty ${f.qty}, value ${f.value})`,
  );
  // An adjustment-only note moves nothing.
  b.saleReturns = [
    {
      id: "N",
      number: "N",
      date: "2026-04-07",
      partyId: "X",
      partyName: "X",
      isAdjustmentOnly: true,
      lineItems: [
        {
          id: "l",
          itemId: "F",
          name: "F",
          qty: 5,
          unit: "MTR",
          price: 1,
          discountPct: 0,
          gstRate: 0,
          amount: 0,
        },
      ],
      subtotal: 0,
      taxAmount: 0,
      total: 0,
      createdAt: "",
    } as Return,
  ];
  [s] = stockSnapshots(b, ["2026-04-07"]);
  assert(
    s.items.find((i) => i.itemId === "F")!.qty === -7,
    "FSV7: a price-only note moves no stock",
  );
}

/* ═══ FS-D: income-tax WDV depreciation ═════════════════════════════════
   Machinery opening WDV 1,00,000 at 15% → 15,000. Plus 40,000 bought in
   June (used 180+ days) → 6,000, and 20,000 bought in January (< 180 days)
   → half rate, 1,500. Total 22,500. */
function depreciation(assert: Assert) {
  const acc = {
    id: "M",
    name: "Machinery",
    group: "fixedAsset",
    depreciationRate: 15,
    openingBalance: 100000,
    openingSide: "dr",
    createdAt: "",
  } as BsAccount;
  const b = emptyBooks();
  const jv = (id: string, date: string, amount: number): JournalVoucher =>
    ({
      id,
      number: id,
      date,
      narration: "Bought machine",
      createdAt: date,
      lines: [
        {
          id: "1",
          kind: "ledger",
          refId: "Machinery",
          refName: "Machinery",
          debit: amount,
          credit: 0,
        },
        { id: "2", kind: "bank", refId: "B", refName: "HDFC", debit: 0, credit: amount },
      ],
    }) as JournalVoucher;
  b.banks = [
    { id: "B", name: "HDFC", openingBalance: 500000, balance: 0, createdAt: "" } as BankAccount,
  ];
  b.journalVouchers = [jv("J1", "2026-06-15", 40000), jv("J2", "2027-01-10", 20000)];
  const input = finInput(b, [acc]);
  const postings = [
    ...input.books.postings,
    {
      date: "",
      account: ACC.ledger("Machinery"),
      amount: paise(100000),
      doc: { kind: "opening" as const, id: "M", label: "o" },
    },
  ];
  const d = wdvDepreciation(acc, postings, "2026-04-01", "2027-03-31");
  assert(d.depreciation === 22500, `FSD1: 15,000 + 6,000 + 1,500 = 22,500, got ${d.depreciation}`);
  // Posting it as a JV (Dr Depreciation, Cr Machinery) moves the schedule and
  // the P&L, and the books still balance.
  b.journalVouchers.push({
    id: "DEP",
    number: "DEP",
    date: "2027-03-31",
    narration: "Depreciation FY 2026-27",
    createdAt: "z",
    lines: [
      {
        id: "1",
        kind: "ledger",
        refId: "Depreciation",
        refName: "Depreciation",
        debit: 22500,
        credit: 0,
      },
      {
        id: "2",
        kind: "ledger",
        refId: "Machinery",
        refName: "Machinery",
        debit: 0,
        credit: 22500,
      },
    ],
  } as JournalVoucher);
  const accounts = [
    acc,
    { id: "D", name: "Depreciation", group: "indirectExpense", createdAt: "" } as BsAccount,
  ];
  const f = buildFinancials(finInput(b, accounts), "2026-04-01", "2027-03-31");
  const row = f.fixedAssets.find((r) => r.name === "Machinery");
  assert(
    row?.opening === 100000 &&
      row.additions === 60000 &&
      row.depreciation === 22500 &&
      row.closing === 137500,
    `FSD2: schedule 1,00,000 + 60,000 − 22,500 = 1,37,500, got ${JSON.stringify(row)}`,
  );
  assert(
    f.indirectExpenses.some((l) => l.label === "Depreciation" && l.amount === 22500),
    "FSD3: depreciation is a P&L expense",
  );
  assert(f.difference === 0, `FSD4: balances, difference ${f.difference}`);
}

/* ═══ FS-R: randomized books balance to the paisa ═══════════════════════ */
function randomized(assert: Assert) {
  let seed = 7777;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const ri = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(a: T[]) => a[ri(a.length)];
  const money = () => r2(100 + rnd() * 20000);
  const dateIn = () => {
    const d = new Date(Date.UTC(2025, 3, 1) + ri(730) * 86400000);
    return d.toISOString().slice(0, 10);
  };

  let failures = 0;
  for (let run = 0; run < 120 && failures < 3; run++) {
    const b = emptyBooks();
    let id = 0;
    const nid = () => `r${run}_${++id}`;
    const created = () => String(1e6 + id);
    b.parties = Array.from(
      { length: 4 },
      (_, i) =>
        ({
          id: `P${i}`,
          name: `Party ${i}`,
          type: pick(["customer", "supplier", "both"]),
          openingBalance: ri(3) ? 0 : r2((rnd() - 0.5) * 20000),
          createdAt: "",
        }) as Party,
    );
    b.banks = Array.from(
      { length: 2 },
      (_, i) =>
        ({
          id: `B${i}`,
          name: `Bank ${i}`,
          openingBalance: ri(2) ? 0 : money(),
          balance: 0,
          createdAt: "",
        }) as BankAccount,
    );
    b.items = Array.from(
      { length: 4 },
      (_, i) =>
        ({
          id: `I${i}`,
          name: `Item ${i}`,
          unit: "PCS",
          gstRate: pick([0, 5, 18]),
          purchasePrice: r2(50 + rnd() * 500),
          salePrice: 0,
          stock: 0,
          openingStock: ri(3) ? 0 : ri(30),
          openingRate: ri(2) ? undefined : r2(40 + rnd() * 400),
          kind: pick(["raw", "finished", "trading"]),
          createdAt: "",
        }) as Item,
    );
    const bankIds = b.banks.map((x) => x.id);

    const splitFor = (
      amount: number,
    ): { mode: Invoice["paymentMode"]; bankId?: string; splits?: PaymentSplit[] } => {
      const kind = ri(5);
      if (kind === 0) return { mode: "cash" };
      if (kind === 1) return { mode: "bank", bankId: pick(bankIds) };
      if (kind === 2) return { mode: "upi" }; // legacy: no account named
      if (kind === 3 && amount > 1) {
        const part = r2(amount * rnd());
        return {
          mode: "cash",
          splits: [
            { mode: "cash", amount: part },
            { mode: "bank", amount: r2(amount - part), bankId: pick(bankIds) },
          ].filter((s) => s.amount > 0),
        };
      }
      return { mode: "cash" };
    };

    const bill = (isSale: boolean): Invoice => {
      const lines: LineItem[] = Array.from({ length: 1 + ri(3) }, () => {
        const it = pick(b.items);
        const qty = 1 + ri(5);
        const price = r2(50 + rnd() * 900);
        return {
          id: nid(),
          itemId: it.id,
          name: it.name,
          qty,
          unit: "PCS",
          price,
          discountPct: pick([0, 0, 5]),
          gstRate: it.gstRate,
          amount: 0,
        } as LineItem;
      });
      const taxable = r2(
        lines.reduce((s, l) => s + l.qty * l.price * (1 - l.discountPct / 100), 0),
      );
      const gstOn = ri(5) > 0;
      const tax = gstOn ? r2(taxable * 0.12) : r2(taxable * 0.05); // gstEnabled false with a stray taxAmount
      const total = Math.round(taxable + (gstOn ? tax : 0));
      const counter = ri(3) === 0 ? 0 : r2(total * rnd());
      const how = splitFor(counter);
      const inv = {
        id: nid(),
        number: `N${id}`,
        date: dateIn(),
        partyId: pick(b.parties).id,
        partyName: "",
        lineItems: lines,
        subtotal: taxable,
        discount: 0,
        taxAmount: tax,
        gstEnabled: gstOn,
        total,
        paid: counter,
        paymentMode: counter > 0 ? how.mode : "credit",
        bankId: counter > 0 && !how.splits ? how.bankId : undefined,
        bankPaidAmount: counter > 0 && how.bankId && !how.splits ? counter : undefined,
        paidSplits: counter > 0 ? how.splits : undefined,
        createdAt: created(),
      } as Invoice;
      inv.partyName = b.parties.find((p) => p.id === inv.partyId)!.name;
      return inv;
    };
    for (let i = 0; i < 8; i++) b.sales.push(bill(true));
    for (let i = 0; i < 6; i++) b.purchases.push(bill(false));

    // Payments settling bills (with discounts), and advances.
    for (let i = 0; i < 6; i++) {
      const isIn = ri(2) === 0;
      const pool = isIn ? b.sales : b.purchases;
      const inv = pick(pool);
      const due = r2(inv.total - inv.paid);
      const how = splitFor(1);
      if (due > 1 && ri(3)) {
        const amount = r2(due * (0.3 + rnd() * 0.6));
        const discount = ri(3) === 0 ? r2(Math.min(due - amount, 50)) : 0;
        inv.paid = r2(inv.paid + amount + discount);
        b.payments.push({
          id: nid(),
          date: inv.date >= "2026-01-01" ? inv.date : dateIn(),
          partyId: inv.partyId,
          partyName: inv.partyName,
          type: isIn ? "in" : "out",
          amount,
          mode: how.mode === "credit" ? "cash" : how.mode,
          bankId: how.bankId,
          allocations: [
            { invoiceId: inv.id, number: inv.number, amount, discount: discount || undefined },
          ],
          createdAt: created(),
        } as Payment);
      } else {
        b.payments.push({
          id: nid(),
          date: dateIn(),
          partyId: pick(b.parties).id,
          partyName: "x",
          type: isIn ? "in" : "out",
          amount: money(),
          mode: ri(6) === 0 ? "credit" : "cash",
          createdAt: created(),
        } as Payment);
      }
    }

    // A JV bill-wise write-off on a sale.
    {
      const inv = pick(b.sales);
      const due = r2(inv.total - inv.paid);
      if (due > 1) {
        const amt = r2(due / 2);
        inv.paid = r2(inv.paid + amt);
        b.journalVouchers.push({
          id: nid(),
          number: `JV${id}`,
          date: dateIn(),
          narration: "write-off",
          createdAt: created(),
          lines: [
            {
              id: "1",
              kind: "party",
              refId: inv.partyId,
              refName: inv.partyName,
              debit: 0,
              credit: amt,
              allocations: [{ docId: inv.id, docKind: "sale", number: inv.number, amount: amt }],
            },
            {
              id: "2",
              kind: "expense",
              refId: "Bad Debts",
              refName: "Bad Debts",
              debit: amt,
              credit: 0,
            },
          ],
        } as JournalVoucher);
      }
    }
    // JVs to register ledgers and to an UNKNOWN ledger (→ suspense).
    for (let i = 0; i < 3; i++) {
      const amt = money();
      const name = pick([
        "Capital",
        "Drawings",
        "HDFC Car Loan",
        "Machinery",
        "Interest Received",
        "Mystery A/c",
      ]);
      b.journalVouchers.push({
        id: nid(),
        number: `JV${id}`,
        date: dateIn(),
        narration: "misc",
        createdAt: created(),
        lines: [
          {
            id: "1",
            kind: "ledger",
            refId: name,
            refName: name,
            debit: ri(2) ? amt : 0,
            credit: 0,
          },
          {
            id: "2",
            kind: pick(["cash", "bank"] as const),
            refId: "B0",
            refName: "x",
            debit: 0,
            credit: 0,
          },
        ].map((l, k, arr) => {
          const dr = arr[0].debit > 0;
          if (k === 0) return dr ? { ...l, debit: amt } : { ...l, credit: amt };
          return dr ? { ...l, credit: amt } : { ...l, debit: amt };
        }),
      } as JournalVoucher);
    }

    // Returns: plain, "increase", and price-only.
    for (let i = 0; i < 3; i++) {
      const src = pick(b.sales);
      const total = r2(src.total * 0.2);
      const r = {
        id: nid(),
        number: `R${id}`,
        date: dateIn(),
        partyId: src.partyId,
        partyName: src.partyName,
        lineItems: src.lineItems.slice(0, 1).map((l) => ({ ...l, qty: 1 })),
        subtotal: total,
        taxAmount: r2(total * 0.1),
        gstEnabled: ri(4) > 0,
        total,
        isAdjustmentOnly: ri(3) === 0,
        direction: ri(4) === 0 ? "increase" : undefined,
        createdAt: created(),
      } as Return;
      (ri(2) ? b.saleReturns : b.purchaseReturns).push(r);
    }
    // Expenses, some with no mode at all (legacy).
    for (let i = 0; i < 4; i++) {
      const how = splitFor(1);
      b.expenses.push({
        id: nid(),
        date: dateIn(),
        category: pick(["Rent", "Salary", "Freight", "GST Paid"]),
        amount: money(),
        paymentMode: ri(6) === 0 ? (undefined as never) : how.mode === "credit" ? "cash" : how.mode,
        bankId: how.bankId,
        createdAt: created(),
      } as Expense);
    }
    // Cash/bank: owner money, and transfers (both legs).
    b.cashAdjustments.push({
      id: nid(),
      date: dateIn(),
      type: pick(["add", "reduce"]),
      amount: money(),
      createdAt: created(),
    } as CashAdjustment);
    b.bankTxns.push({
      id: nid(),
      bankId: pick(bankIds),
      date: dateIn(),
      type: pick(["deposit", "withdraw"]),
      amount: money(),
      createdAt: created(),
    } as BankTxn);
    {
      const tid = nid();
      const amt = money();
      const date = dateIn();
      b.cashAdjustments.push({
        id: nid(),
        date,
        type: "reduce",
        amount: amt,
        transferId: tid,
        createdAt: created(),
      } as CashAdjustment);
      b.bankTxns.push({
        id: nid(),
        bankId: pick(bankIds),
        date,
        type: "deposit",
        amount: amt,
        transferId: tid,
        createdAt: created(),
      } as BankTxn);
    }
    // Stock adjustments and a production run.
    b.stockAdjustments.push({
      id: nid(),
      itemId: pick(b.items).id,
      itemName: "x",
      date: dateIn(),
      type: pick(["add", "reduce"]),
      qty: 1 + ri(4),
      createdAt: created(),
    } as StockAdjustment);
    b.productions.push({
      id: nid(),
      date: dateIn(),
      createdAt: created(),
      finishedItemId: "I0",
      qty: 1 + ri(3),
      additionalCost: money(),
      components: [
        { itemId: "I1", itemName: "x", unit: "PCS", qty: 1 + ri(5), rate: 0, amount: 0 },
      ],
    } as unknown as Production);

    const accounts: BsAccount[] = [
      { id: "a1", name: "Capital", group: "capital", createdAt: "" },
      { id: "a2", name: "Drawings", group: "drawings", createdAt: "" },
      {
        id: "a3",
        name: "HDFC Car Loan",
        group: "securedLoan",
        openingBalance: 50000,
        openingSide: "cr",
        createdAt: "",
      },
      {
        id: "a4",
        name: "Machinery",
        group: "fixedAsset",
        openingBalance: 80000,
        openingSide: "dr",
        depreciationRate: 15,
        createdAt: "",
      },
      { id: "a5", name: "Interest Received", group: "otherIncome", createdAt: "" },
      { id: "a6", name: "GST Payable", group: "dutiesTaxes", createdAt: "" },
    ];
    const config: FinConfig = {
      id: "config",
      expenseClass: { Freight: "direct", "GST Paid": "account:GST Payable" },
      createdAt: "",
    };
    const input = finInput(b, accounts, config);

    const off = unbalancedDocs(input.books.postings);
    if (off.length) {
      failures++;
      assert(false, `FSR run ${run}: unbalanced document ${off[0].doc.label} by ${off[0].off}`);
      continue;
    }
    for (const [from, to] of [
      ["2025-04-01", "2026-03-31"],
      ["2026-04-01", "2027-03-31"],
      ["2025-10-01", "2026-06-30"],
    ]) {
      const f = buildFinancials(input, from, to);
      const dr = Math.round(f.trial.reduce((n, t) => n + t.debit, 0) * 100);
      const cr = Math.round(f.trial.reduce((n, t) => n + t.credit, 0) * 100);
      if (f.difference !== 0 || dr !== cr) {
        failures++;
        assert(
          false,
          `FSR run ${run} ${from}..${to}: difference ${f.difference}, trial Dr ${dr / 100} vs Cr ${cr / 100}`,
        );
        break;
      }
      assert(true, "FSR: balances");

      // Cross-checks against the screens, at the closing date.
      const books = input.books;
      const bal = balances(books.postings, to);
      const data = {
        sales: b.sales,
        purchases: b.purchases,
        saleReturns: b.saleReturns,
        purchaseReturns: b.purchaseReturns,
        payments: b.payments,
        journalVouchers: b.journalVouchers,
      };
      for (const p of b.parties) {
        const st = buildPartyStatement(p, data, "", to);
        const screen = st.rows[st.rows.length - 1].balance;
        const books_ = (bal.get(ACC.party(p.id)) ?? 0) / 100;
        if (Math.abs(screen - books_) > 0.005) {
          failures++;
          assert(
            false,
            `FSR run ${run}: party ${p.id} at ${to} — statement ${screen} vs books ${books_}`,
          );
        }
      }
      for (const bk of b.banks) {
        const led = buildBankLedger(
          bk,
          { ...data, bankTxns: b.bankTxns, expenses: b.expenses },
          "",
          to,
        );
        const screen = led.rows.length ? led.rows[led.rows.length - 1].balance : bk.openingBalance;
        const books_ = (bal.get(ACC.bank(bk.id)) ?? 0) / 100;
        if (Math.abs(screen - books_) > 0.005) {
          failures++;
          assert(
            false,
            `FSR run ${run}: bank ${bk.id} at ${to} — passbook ${screen} vs books ${books_}`,
          );
        }
      }
      const cashScreen = r2(
        cashFlows(
          b.sales,
          b.purchases,
          b.expenses,
          b.payments,
          b.cashAdjustments,
          b.journalVouchers,
        )
          .filter((e) => e.date <= to)
          .reduce((n, e) => n + e.in - e.out, 0),
      );
      const cashBooks = (bal.get(ACC.cash) ?? 0) / 100;
      if (Math.abs(cashScreen - cashBooks) > 0.005) {
        failures++;
        assert(
          false,
          `FSR run ${run}: cash at ${to} — Cash page ${cashScreen} vs books ${cashBooks}`,
        );
      }
    }
  }
  assert(
    failures === 0,
    `FSR: every randomized book balanced and matched the screens (${failures} failures)`,
  );
  void dayBefore;
}

const approx = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps;

/* ═══ FS-A: an item's cost is its weighted average, not its last rate ════
   Bought 10 m at ₹300 and later 10 m at ₹350: the last purchase rate is 350,
   but every metre on the shelf cost on average 325 — that is its cost.
   After selling 5 m the average does not move (goods leave AT average). */
function averageCost(assert: Assert) {
  const b = emptyBooks();
  b.items = [
    {
      id: "F",
      name: "Fabric",
      unit: "MTR",
      gstRate: 5,
      purchasePrice: 350,
      salePrice: 0,
      stock: 15,
      openingStock: 0,
      createdAt: "",
    } as Item,
  ];
  const bill = (id: string, date: string, qty: number, price: number) =>
    ({
      id,
      number: id,
      date,
      partyId: "X",
      partyName: "X",
      subtotal: 0,
      discount: 0,
      taxAmount: 0,
      total: 0,
      paid: 0,
      paymentMode: "credit",
      createdAt: date,
      lineItems: [
        {
          id: "l",
          itemId: "F",
          name: "F",
          qty,
          unit: "MTR",
          price,
          discountPct: 0,
          gstRate: 5,
          amount: 0,
        },
      ],
    }) as Invoice;
  b.purchases = [bill("P1", "2026-05-01", 10, 300), bill("P2", "2026-06-01", 10, 350)];
  assert(
    averageCosts(b).get("F") === 325,
    `FSA1: average of 10 @ 300 and 10 @ 350 is 325, got ${averageCosts(b).get("F")}`,
  );
  b.sales = [bill("S1", "2026-06-02", 5, 500)];
  assert(averageCosts(b).get("F") === 325, "FSA2: selling does not change the average");
  // An item never bought falls back to its opening/purchase price.
  b.items.push({
    id: "G",
    name: "Glue",
    unit: "PCS",
    gstRate: 18,
    purchasePrice: 40,
    salePrice: 0,
    stock: 0,
    openingStock: 0,
    createdAt: "",
  } as Item);
  assert(averageCosts(b).get("G") === 40, "FSA3: no history → the price typed on the item");
}
