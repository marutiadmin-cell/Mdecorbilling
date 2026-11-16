/**
 * Dummy M Décor data — a whole shop's worth, for showing and testing every
 * page: blinds hardware and slats, curtain fabrics, sofa materials, parties,
 * ~two years of sales, purchases, payments, returns, expenses, cash & bank,
 * journals, quotations, proformas, a fixed and a made-to-measure BOM, and
 * production runs.
 *
 * Built as plain arrays (pure — no repository is touched here). Two users:
 *   - the test harness (tests/demoShop.ts) loads it into an in-memory shop;
 *   - Settings → Demo data (lib/demoLoader.ts) saves it into the LIVE books,
 *     where it must never be mistaken for, or disturb, the shop's own:
 *       · every id starts "demo-"   → "Delete demo data" removes exactly these
 *       · every name says "Demo"    → nobody bills a real customer by mistake
 *       · every number ENDS "-DEMO" → nextInvoiceNumber reads trailing digits
 *         only, so a real invoice series never jumps (INV-0012 stays next)
 *       · no GSTINs                 → nothing fake reaches a GST return
 *
 * Consistent by construction: stock, bank balances and bank-paid amounts are
 * worked out by the app's own Fix calculations over the demo records alone.
 */
import type {
  BankAccount,
  BankTxn,
  Bom,
  BsAccount,
  CashAdjustment,
  Estimate,
  Expense,
  Invoice,
  Item,
  JournalVoucher,
  LineItem,
  MtmSettings,
  Party,
  Payee,
  Payment,
  Production,
  Return,
  StockAdjustment,
} from "@/types";
import { planDataRepair } from "@/lib/dataRepair";
import { consumptionFor } from "@/lib/production";
import { consumptionForSize, madeQty, bomVars, resolveComponents } from "@/lib/sizing";
import { planCuts, lenKey } from "@/lib/cutting";
import type { PieceCount, PieceSort, JobCard } from "@/types";
import { costSheet } from "@/lib/sizing";
import { ymd } from "@/lib/format";

const r2 = (n: number) => Math.round(n * 100) / 100;

export const DEMO_ID_PREFIX = "demo-";
export const isDemoId = (id: string | undefined) => !!id && id.startsWith(DEMO_ID_PREFIX);

export interface DemoShop {
  items: Item[];
  parties: Party[];
  payees: Payee[];
  banks: BankAccount[];
  sales: Invoice[];
  purchases: Invoice[];
  payments: Payment[];
  saleReturns: Return[];
  purchaseReturns: Return[];
  expenses: Expense[];
  cashAdjustments: CashAdjustment[];
  bankTxns: BankTxn[];
  journals: JournalVoucher[];
  stockAdjustments: StockAdjustment[];
  estimates: Estimate[];
  boms: Bom[];
  productions: Production[];
  /** By-length stock (slats, rails) sorted into sizes. */
  pieceSorts: PieceSort[];
  /** Workshop job cards for the measured blind orders. */
  jobCards: JobCard[];
  bsAccounts: BsAccount[];
  /** Settings → Manufacturing for made-to-measure work. */
  mtm: MtmSettings;
  expenseCategories: string[];
}

export function buildDemoShop(
  opts: {
    scale?: number;
    seed?: number;
    live?: boolean;
    /** Live, but looking like a real shop: no "Demo" in names, no "-DEMO" on
     *  numbers (ids still start "demo-"). For a database that will be wiped
     *  before the shop goes live. */
    plain?: boolean;
    /** Continue each series after what the books already hold, e.g.
     *  { "INV-": 3 } makes the first sale INV-0004. */
    numberFrom?: Record<string, number>;
  } = {},
): DemoShop {
  const scale = opts.scale ?? 1;
  const live = !!opts.live;
  const labels = live && !opts.plain;
  let s = (opts.seed ?? 20261116) >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const ri = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(a: T[]): T => a[ri(a.length)];
  let serial = 0;
  /** Live: every id "demo-…". In tests the fixed ids stay as they were. */
  const pfx = live ? DEMO_ID_PREFIX : "";
  const id = (p: string) => `${pfx}${p}-${++serial}`;
  const fixed = (x: string) => `${pfx}${x}`;
  const nm = (x: string) => (labels ? `Demo ${x}` : x);
  const num = (series: string, n: number) =>
    `${series}${String(n + (opts.numberFrom?.[series] ?? 0)).padStart(4, "0")}${labels ? "-DEMO" : ""}`;

  const today = new Date();
  const dayAgo = (n: number) => ymd(new Date(today.getTime() - n * 86400000));
  // Last ~22 months, with plenty in the CURRENT month so "this month" lists fill.
  const date = () => (ri(3) === 0 ? dayAgo(ri(Math.max(1, today.getDate()))) : dayAgo(ri(660)));
  const createdAt = (d: string) =>
    `${d}T${String(9 + ri(10)).padStart(2, "0")}:${String(ri(60)).padStart(2, "0")}:00Z`;
  const T0 = "2025-01-01T00:00:00Z";

  const mtm: MtmSettings = {
    sizeUnit: "in",
    minSqft: 15,
    constants: [
      { key: "SLAT_PITCH", value: 1.13, note: "Wooden slat spacing (in)" },
      { key: "LADDER_GAP", value: 24, note: "One ladder every (in)" },
    ],
    productTypes: [
      "Easy Lift (Single Dori / Chain System)",
      "Cord Lift",
      "Roller",
      "Zebra",
      "Curtain",
    ],
    operateSides: ["Left", "Right", "Centre"],
    jobStages: ["New", "Cutting", "Assembly", "Ready", "Fitted"],
    completeStage: "Ready",
    jobPrefix: "WB-",
  };
  const expenseCategories = [
    "Rent",
    "Karigar wages",
    "Transport",
    "Electricity",
    "Tea & snacks",
    "Freight",
  ];

  /* ── Banks ── */
  const banks: BankAccount[] = [
    {
      id: fixed("BANK-HDFC"),
      name: nm("HDFC Current"),
      openingBalance: 150000,
      balance: 0,
      createdAt: T0,
    },
    {
      id: fixed("BANK-SBI"),
      name: nm("SBI Savings"),
      openingBalance: 40000,
      balance: 0,
      createdAt: T0,
    },
  ] as BankAccount[];

  /* ── Items ── */
  const items: Item[] = [];
  const addItem = (p: Partial<Item> & { name: string }) => {
    const it = {
      unit: "PCS",
      gstRate: 18,
      purchasePrice: 100,
      salePrice: 150,
      stock: 0,
      openingStock: 0,
      createdAt: T0,
      ...p,
      id: p.id ?? id("IT"),
      name: nm(p.name),
    } as Item;
    items.push(it);
    return it;
  };
  const blindRaw = [
    ["DB-BOT", "Bottom rail", "MTR", 230],
    ["DB-SLT", "Slat 50mm Wooden", "PCS", 54],
    ["DB-HR", "Head rail", "FT", 112],
    ["DB-MEC", "Mechanism Easy Lift", "PCS", 218],
    ["DB-ATR", "ATR", "PCS", 140],
    ["DB-CHN", "Chain", "PCS", 50],
    ["DB-LT", "Ladder tape", "PCS", 30],
    ["DB-ROD", "Rod", "FT", 18],
    ["DB-CB", "Ceiling bracket", "PCS", 30],
    ["DB-DOR", "Dori (andar ni)", "PCS", 3],
    ["DB-BL", "Bottom lock", "PCS", 10],
  ] as const;
  // Slats, rails and rod are kept BY LENGTH — bought as long pieces, cut to
  // each blind, offcuts kept by size (lib/cutting.ts).
  const BY_LENGTH: Record<
    string,
    {
      unit: string;
      price: number;
      opening: number;
      pieces: { minOffcut: number; barLength: number };
      sizes: PieceCount[];
    }
  > = {
    "DB-SLT": {
      unit: "FT",
      price: 11,
      opening: 20000,
      pieces: { minOffcut: 1, barLength: 20 },
      sizes: [
        { length: 20, count: 900 },
        { length: 10, count: 150 },
        { length: 5, count: 100 },
      ],
    },
    "DB-HR": {
      unit: "FT",
      price: 112,
      opening: 1200,
      pieces: { minOffcut: 1, barLength: 16 },
      sizes: [{ length: 16, count: 75 }],
    },
    "DB-ROD": {
      unit: "FT",
      price: 18,
      opening: 1200,
      pieces: { minOffcut: 1, barLength: 16 },
      sizes: [{ length: 16, count: 75 }],
    },
    "DB-BOT": {
      unit: "MTR",
      price: 230,
      opening: 1000,
      pieces: { minOffcut: 0.3, barLength: 5 },
      sizes: [{ length: 5, count: 200 }],
    },
  };
  for (const [iid, name, unit, price] of blindRaw) {
    const bl = BY_LENGTH[iid];
    addItem({
      id: fixed(iid),
      name,
      unit: bl?.unit ?? unit,
      kind: "raw",
      purchasePrice: bl?.price ?? price,
      salePrice: r2((bl?.price ?? price) * 1.4),
      openingStock: bl?.opening ?? 400,
      gstRate: 18,
      category: "Blind hardware",
      pieces: bl?.pieces,
    });
  }
  const pieceSorts: PieceSort[] = Object.entries(BY_LENGTH).map(([iid, bl]) => ({
    id: id("PS"),
    itemId: fixed(iid),
    itemName: nm(blindRaw.find((r) => r[0] === iid)![1]),
    date: dayAgo(700),
    pieces: bl.sizes,
    note: "Opening stock",
    createdAt: T0,
  }));
  addItem({
    id: fixed("DB-BLIND"),
    name: "Wooden Blind Easy Lift",
    unit: "SQFT",
    kind: "finished",
    purchasePrice: 0,
    salePrice: 480,
    gstRate: 12,
    category: "Blinds",
  });
  addItem({
    id: fixed("DB-ROLLER"),
    name: "Roller Blind Blackout",
    unit: "SQFT",
    kind: "finished",
    purchasePrice: 0,
    salePrice: 160,
    gstRate: 12,
    category: "Blinds",
  });
  addItem({
    id: fixed("DS-FAB"),
    name: "Velvet Fabric Royal Blue",
    unit: "MTR",
    kind: "raw",
    purchasePrice: 300,
    salePrice: 450,
    openingStock: 300,
    gstRate: 5,
    category: "Fabric",
  });
  addItem({
    id: fixed("DS-FOAM"),
    name: 'Foam Sheet 4" HD',
    unit: "PCS",
    kind: "raw",
    purchasePrice: 900,
    salePrice: 1200,
    openingStock: 80,
    gstRate: 18,
    category: "Foam",
  });
  addItem({
    id: fixed("DS-FRAME"),
    name: "Wooden Frame 3 Seater",
    unit: "SET",
    kind: "raw",
    purchasePrice: 4500,
    salePrice: 0,
    openingStock: 20,
    gstRate: 18,
    category: "Frames",
  });
  addItem({
    id: fixed("DS-SOFA3"),
    name: "Sofa 3 Seater Royal",
    unit: "PCS",
    kind: "finished",
    purchasePrice: 0,
    salePrice: 32000,
    gstRate: 18,
    category: "Sofa",
  });
  addItem({
    id: fixed("DS-SOFA2"),
    name: "Sofa 2 Seater",
    unit: "PCS",
    kind: "finished",
    purchasePrice: 0,
    salePrice: 22000,
    gstRate: 18,
    category: "Sofa",
  });
  const fabrics = [
    "Linen",
    "Velvet",
    "Blackout",
    "Sheer",
    "Jacquard",
    "Cotton",
    "Silk",
    "Polyester",
  ];
  const colours = [
    "Ivory",
    "Beige",
    "Grey",
    "Navy",
    "Maroon",
    "Teal",
    "Mustard",
    "Olive",
    "Rust",
    "Charcoal",
  ];
  for (let i = 0; i < Math.round(60 * scale); i++) {
    const cost = r2(120 + ri(600));
    addItem({
      name: `${pick(fabrics)} Curtain Fabric ${pick(colours)} ${100 + i}`,
      unit: "MTR",
      kind: ri(2) ? "raw" : "trading",
      purchasePrice: cost,
      salePrice: r2(cost * (1.3 + rnd() * 0.6)),
      openingStock: ri(4) ? ri(200) : 0,
      minStock: ri(3) ? 20 : undefined,
      gstRate: 5,
      category: "Curtain fabric",
      hsn: "5407",
    });
  }
  const trading = [
    "Cushion Cover",
    "Curtain Rod",
    "Curtain Ring Set",
    "Tie Back",
    "Bean Bag",
    "Table Runner",
    "Wall Paper Roll",
    "Mattress Queen",
    "Pillow",
    "Bed Sheet",
  ];
  for (let i = 0; i < Math.round(60 * scale); i++) {
    const cost = r2(80 + ri(3000));
    addItem({
      name: `${pick(trading)} ${pick(colours)} ${200 + i}`,
      unit: pick(["PCS", "PCS", "SET", "ROLL"]),
      kind: "trading",
      purchasePrice: cost,
      salePrice: r2(cost * (1.2 + rnd() * 0.8)),
      wholesalePrice: ri(2) ? r2(cost * 1.15) : undefined,
      openingStock: ri(5) ? ri(60) : 0,
      gstRate: pick([5, 12, 18]),
      category: pick(["Accessories", "Bedding", "Decor"]),
      hsn: pick(["6304", "9404", "4814", ""]) || undefined,
    });
  }
  // Messy records an import or an older app leaves behind — tests only; the
  // live demo is for showing the shop, and should look tidy.
  if (!live) {
    addItem({
      name: "Old Stock Lot (imported)",
      unit: "",
      purchasePrice: undefined as never,
      salePrice: "350" as never,
      stock: "12" as never,
      openingStock: 12,
      gstRate: undefined as never,
    });
    addItem({
      name: "ચેઇન Chain Metal",
      unit: "PCS",
      kind: "raw",
      purchasePrice: 50,
      salePrice: 90,
      openingStock: 0,
      gstRate: 18,
    });
  }

  /* ── Parties & payees ── */
  const parties: Party[] = [];
  const firstNames = [
    "Patel",
    "Shah",
    "Desai",
    "Mehta",
    "Joshi",
    "Kunteshwar",
    "Rana",
    "Parmar",
    "Solanki",
    "Trivedi",
    "Bhatt",
    "Vora",
  ];
  const kinds = ["Furniture", "Interiors", "Traders", "Home Decor", "Builders", "Enterprise"];
  const nParty = Math.round(60 * scale);
  for (let i = 0; i < nParty; i++) {
    const type = i < nParty * 0.6 ? "customer" : i < nParty * 0.9 ? "supplier" : "both";
    const gst = !labels && ri(3) === 0;
    parties.push({
      id: id("PT"),
      name: nm(`${pick(firstNames)} ${pick(kinds)} ${i + 1}`),
      type,
      phone: `9${String(100000000 + ri(899999999))}`,
      gstin: gst ? (ri(4) ? "24AAACC1234D1ZI" : "27AAACC1234D1ZC") : undefined,
      state: gst ? undefined : "Gujarat",
      city: pick(["Surat", "Ahmedabad", "Vadodara", "Navsari", "Mumbai"]),
      address: `${1 + ri(300)}, ${pick(["Ring Road", "Station Road", "Adajan", "Varachha", "Vesu"])}`,
      openingBalance: ri(4) === 0 ? r2((rnd() - 0.4) * 30000) : 0,
      createdAt: T0,
    } as Party);
  }
  const customers = parties.filter((p) => p.type !== "supplier");
  const suppliers = parties.filter((p) => p.type !== "customer");
  const payees: Payee[] = [
    "Ramesh Karigar",
    "Landlord Shah",
    "GEB Electricity",
    "Tempo Raju",
    "Chai Wala",
  ].map((n) => ({ id: id("PY"), name: nm(n), createdAt: T0 }) as Payee);

  /* ── Bills ── */
  const sellable = items.filter((i) => !i.pieces && (i.kind !== "raw" || ri(4) === 0));
  const buyable = items.filter((i) => i.kind !== "finished");
  const makeBill = (isSale: boolean, number: string): Invoice => {
    const party = pick(isSale ? customers : suppliers);
    const gstOn = ri(5) > 0;
    const d = date();
    const lines: LineItem[] = Array.from({ length: 1 + ri(4) }, () => {
      const it = pick(isSale ? sellable : buyable);
      // Slats and rails are bought BY THE PIECE (20 ft × 7), straight into sizes.
      const pcs =
        !isSale && it.pieces
          ? [{ length: it.pieces.barLength ?? 10, count: 2 + ri(9) }]
          : undefined;
      const qty = pcs
        ? r2(pcs[0].length * pcs[0].count)
        : it.unit === "MTR"
          ? r2(1 + rnd() * 25)
          : 1 + ri(6);
      const price = Number(isSale ? it.salePrice : it.purchasePrice) || 100;
      const discountPct = ri(5) === 0 ? 5 : 0;
      const gstRate = Number(it.gstRate) || 0;
      const taxable = r2(qty * price * (1 - discountPct / 100));
      return {
        id: id("L"),
        itemId: it.id,
        name: it.name,
        qty,
        unit: it.unit,
        price,
        discountPct,
        gstRate,
        amount: r2(taxable + (gstOn ? r2((taxable * gstRate) / 100) : 0)),
        costPrice: isSale ? Number(it.purchasePrice) || 0 : undefined,
        hsn: it.hsn,
        pieces: pcs,
      } as LineItem;
    });
    const subtotal = r2(lines.reduce((a, l) => a + l.qty * l.price, 0));
    const afterDisc = r2(
      lines.reduce((a, l) => a + r2(l.qty * l.price * (1 - l.discountPct / 100)), 0),
    );
    const tax = gstOn
      ? r2(
          lines.reduce(
            (a, l) => a + r2((r2(l.qty * l.price * (1 - l.discountPct / 100)) * l.gstRate) / 100),
            0,
          ),
        )
      : 0;
    const raw = r2(afterDisc + tax);
    const total = Math.round(raw);
    const how = ri(10);
    const mode = how < 4 ? "cash" : how < 6 ? "bank" : how < 7 ? "upi" : "credit";
    const paid = mode === "credit" ? 0 : ri(4) === 0 ? r2(total * (0.3 + rnd() * 0.5)) : total;
    const bankId = mode === "bank" ? pick(banks).id : undefined;
    const split = mode === "cash" && paid > 1000 && ri(6) === 0;
    return {
      id: id(isSale ? "S" : "P"),
      number,
      date: d,
      partyId: party.id,
      partyName: party.name,
      partyPhone: party.phone,
      partyGstin: party.gstin,
      partyState: party.state,
      placeOfSupply: party.gstin?.slice(0, 2) ?? "24",
      lineItems: lines,
      subtotal,
      discount: 0,
      taxAmount: tax,
      gstEnabled: gstOn,
      taxCalcVersion: 2,
      roundOff: r2(total - raw),
      total,
      paid,
      paymentMode: mode,
      bankId: split ? undefined : bankId,
      paidSplits: split
        ? [
            { mode: "cash", amount: r2(paid / 2) },
            { mode: "bank", amount: r2(paid - r2(paid / 2)), bankId: banks[0].id },
          ]
        : undefined,
      notes: labels ? "Demo data" : undefined,
      createdAt: createdAt(d),
    } as Invoice;
  };
  const sales = Array.from({ length: Math.round(300 * scale) }, (_, i) =>
    makeBill(true, num("INV-", i + 1)),
  );
  const purchases = Array.from({ length: Math.round(120 * scale) }, (_, i) =>
    makeBill(false, num("PUR-", i + 1)),
  );

  /* ── Payments ── */
  const payments: Payment[] = [];
  for (let i = 0; i < Math.round(110 * scale); i++) {
    const isIn = ri(3) > 0;
    const pool = (isIn ? sales : purchases).filter((b) => b.total - b.paid > 1);
    if (pool.length && ri(5)) {
      const inv = pick(pool);
      const due = r2(inv.total - inv.paid);
      const amount = ri(3) ? due : r2(due * (0.3 + rnd() * 0.6));
      const discount = amount === due && ri(6) === 0 ? Math.min(50, r2(due * 0.02)) : 0;
      const pay = discount ? r2(amount - discount) : amount;
      inv.paid = r2(inv.paid + pay + discount);
      const age = Math.max(
        1,
        Math.floor((today.getTime() - new Date(inv.date).getTime()) / 86400000),
      );
      const d = inv.date > dayAgo(5) ? inv.date : dayAgo(ri(age));
      const bank = ri(2) ? pick(banks).id : undefined;
      payments.push({
        id: id("PM"),
        date: d,
        partyId: inv.partyId,
        partyName: inv.partyName,
        type: isIn ? "in" : "out",
        amount: pay,
        mode: bank ? "bank" : "cash",
        bankId: bank,
        reference: bank && ri(2) ? `UTR${100000 + ri(899999)}` : undefined,
        allocations: [
          { invoiceId: inv.id, number: inv.number, amount: pay, discount: discount || undefined },
        ],
        createdAt: createdAt(d),
      } as Payment);
    } else {
      const party = pick(isIn ? customers : suppliers);
      const d = date();
      payments.push({
        id: id("PM"),
        date: d,
        partyId: party.id,
        partyName: party.name,
        type: isIn ? "in" : "out",
        amount: r2(1000 + ri(20000)),
        mode: "cash",
        notes: "Advance",
        createdAt: createdAt(d),
      } as Payment);
    }
  }

  /* ── Returns ── */
  const saleReturns: Return[] = [];
  const purchaseReturns: Return[] = [];
  for (let i = 0; i < Math.round(25 * scale); i++) {
    const isSale = ri(3) > 0;
    const src = pick(isSale ? sales : purchases);
    const l = src.lineItems[0];
    const qty = l.unit === "MTR" ? r2(Math.min(l.qty, 1 + rnd() * 3)) : 1;
    const taxable = r2(qty * l.price * (1 - l.discountPct / 100));
    const tax = src.gstEnabled ? r2((taxable * l.gstRate) / 100) : 0;
    const total = Math.round(taxable + tax);
    const d = src.date > dayAgo(3) ? src.date : dayAgo(ri(30));
    const list = isSale ? saleReturns : purchaseReturns;
    list.push({
      id: id(isSale ? "SR" : "PR"),
      number: num(isSale ? "SR-" : "PR-", list.length + 1),
      date: d,
      partyId: src.partyId,
      partyName: src.partyName,
      originalRef: src.number,
      reason: pick(["damaged", "wrong_item", "other"]),
      lineItems: [{ ...l, pieces: undefined, id: id("L"), qty, amount: r2(taxable + tax) }],
      subtotal: taxable,
      taxAmount: tax,
      gstEnabled: src.gstEnabled,
      total,
      createdAt: createdAt(d),
    } as unknown as Return);
  }

  /* ── Expenses ── */
  const expenses: Expense[] = [];
  for (let i = 0; i < Math.round(90 * scale); i++) {
    const d = date();
    const bank = ri(4) === 0 ? pick(banks).id : undefined;
    expenses.push({
      id: id("EX"),
      date: d,
      category: pick(expenseCategories),
      amount: r2(100 + ri(15000)),
      paymentMode: bank ? "bank" : "cash",
      bankId: bank,
      payeeName: ri(2) ? pick(payees).name : undefined,
      notes: labels ? "Demo data" : undefined,
      createdAt: createdAt(d),
    } as Expense);
  }

  /* ── Cash & bank entries ── */
  const cashAdjustments: CashAdjustment[] = [];
  const bankTxns: BankTxn[] = [];
  for (let i = 0; i < Math.round(10 * scale); i++) {
    const d = date();
    cashAdjustments.push({
      id: id("CA"),
      date: d,
      type: pick(["add", "reduce"]),
      amount: r2(2000 + ri(20000)),
      reason: nm(pick(["Owner put in", "Owner took", "Petty cash"])),
      createdAt: createdAt(d),
    } as CashAdjustment);
    bankTxns.push({
      id: id("BT"),
      bankId: pick(banks).id,
      date: d,
      type: pick(["deposit", "withdraw"]),
      amount: r2(5000 + ri(40000)),
      note: nm("Counter"),
      createdAt: createdAt(d),
    } as unknown as BankTxn);
  }

  /* ── Journals, with register accounts for their ledgers ── */
  const ledger = {
    capital: nm("Capital"),
    drawings: nm("Drawings"),
    loan: nm("HDFC Car Loan"),
    machinery: nm("Machinery"),
  };
  const journals: JournalVoucher[] = [];
  for (let i = 0; i < Math.round(8 * scale); i++) {
    const d = date();
    const name = pick(Object.values(ledger));
    const amt = r2(5000 + ri(80000));
    const dr = name === ledger.drawings || name === ledger.machinery;
    journals.push({
      id: id("JV"),
      number: num("JV-", i + 1),
      date: d,
      narration: `${name} entry`,
      createdAt: createdAt(d),
      lines: [
        {
          id: "1",
          kind: "ledger",
          refId: name,
          refName: name,
          debit: dr ? amt : 0,
          credit: dr ? 0 : amt,
        },
        {
          id: "2",
          kind: "bank",
          refId: banks[0].id,
          refName: banks[0].name,
          debit: dr ? 0 : amt,
          credit: dr ? amt : 0,
        },
      ],
    } as JournalVoucher);
  }
  const bsAccounts: BsAccount[] = [
    {
      id: fixed("BS-CAP"),
      name: ledger.capital,
      group: "capital",
      openingBalance: 500000,
      openingSide: "cr",
      createdAt: T0,
    },
    { id: fixed("BS-DRW"), name: ledger.drawings, group: "drawings", createdAt: T0 },
    {
      id: fixed("BS-LOAN"),
      name: ledger.loan,
      group: "securedLoan",
      openingBalance: 300000,
      openingSide: "cr",
      createdAt: T0,
    },
    {
      id: fixed("BS-MACH"),
      name: ledger.machinery,
      group: "fixedAsset",
      openingBalance: 120000,
      openingSide: "dr",
      depreciationRate: 15,
      createdAt: T0,
    },
  ] as BsAccount[];

  /* ── Stock adjustments ── */
  const stockAdjustments: StockAdjustment[] = [];
  for (let i = 0; i < Math.round(15 * scale); i++) {
    const it = pick(items.filter((x) => !x.pieces));
    const d = date();
    stockAdjustments.push({
      id: id("SA"),
      itemId: it.id,
      itemName: it.name,
      date: d,
      type: pick(["add", "reduce"]),
      qty: 1 + ri(5),
      reason: pick(["Damaged", "Count correction", "Sample"]),
      createdAt: createdAt(d),
    } as StockAdjustment);
  }

  /* ── Quotations & proformas ── */
  const estimates: Estimate[] = [];
  for (let i = 0; i < Math.round(30 * scale); i++) {
    const kind = ri(2) ? "quotation" : "proforma";
    const b = makeBill(true, "");
    estimates.push({
      id: id("ES"),
      kind,
      status: pick(["open", "open", "converted", "cancelled"]),
      number: num(kind === "quotation" ? "QT-" : "PF-", i + 1),
      date: b.date,
      validUntil: dayAgo(-15),
      partyId: b.partyId,
      partyName: b.partyName,
      lineItems: b.lineItems,
      subtotal: b.subtotal,
      discount: 0,
      taxAmount: b.taxAmount,
      gstEnabled: b.gstEnabled,
      taxCalcVersion: 2,
      roundOff: b.roundOff,
      total: b.total,
      createdAt: b.createdAt,
    } as Estimate);
  }

  /* ── BOMs & production ── */
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const nameOf = (iid: string) => byId.get(fixed(iid))!.name;
  const c = (iid: string, qtyFormula: string, resultUnit?: string) => ({
    itemId: fixed(iid),
    itemName: nameOf(iid),
    unit: byId.get(fixed(iid))!.unit,
    qty: 0,
    qtyFormula,
    resultUnit,
  });
  /** A by-length material cut as pieces: how many, each how long (inches). */
  const cutRow = (iid: string, countFormula: string, lengthFormula: string) => ({
    itemId: fixed(iid),
    itemName: nameOf(iid),
    unit: byId.get(fixed(iid))!.unit,
    qty: 0,
    cut: { countFormula, lengthFormula },
  });
  const sizedBom: Bom = {
    id: fixed("BOM-EASY"),
    name: nm("Wooden Blind — Easy Lift"),
    finishedItemId: fixed("DB-BLIND"),
    finishedItemName: nameOf("DB-BLIND"),
    outputQty: 1,
    components: [
      cutRow("DB-BOT", "1", "W"),
      cutRow("DB-SLT", "CEIL(H / SLAT_PITCH)", "W"),
      cutRow("DB-HR", "1", "W"),
      c("DB-MEC", "2"),
      c("DB-ATR", "CEIL(W / LADDER_GAP)"),
      c("DB-CHN", "1"),
      c("DB-LT", "CEIL(W / LADDER_GAP)"),
      cutRow("DB-ROD", "1", "W"),
      c("DB-CB", "2"),
      c("DB-DOR", "CEIL(W / LADDER_GAP)"),
      c("DB-BL", "CEIL(W / LADDER_GAP)"),
    ],
    additionalCosts: [{ label: "Karigar labour", amount: 350 }],
    sizing: {
      formulaUnit: "in",
      // Self-contained: the BOM carries its own pitch and ladder spacing, so
      // it works even where Settings has no constants yet.
      inputs: [
        { key: "SLAT_PITCH", label: "Slat pitch (in)", default: 1.13 },
        { key: "LADDER_GAP", label: "One ladder every (in)", default: 24 },
      ],
      pricing: {
        basis: "sqft",
        minSqft: 15,
        addPerUnit: 47,
        minMarginPct: 10,
        maxMarginPct: 54,
        roundLines: "up",
      },
    },
    createdAt: T0,
  };
  const sofaBom: Bom = {
    id: fixed("BOM-SOFA3"),
    name: nm("Sofa 3 Seater Royal"),
    finishedItemId: fixed("DS-SOFA3"),
    finishedItemName: nameOf("DS-SOFA3"),
    outputQty: 1,
    components: [
      { itemId: fixed("DS-FAB"), itemName: nameOf("DS-FAB"), unit: "MTR", qty: 12, wastagePct: 5 },
      { itemId: fixed("DS-FOAM"), itemName: nameOf("DS-FOAM"), unit: "PCS", qty: 4 },
      { itemId: fixed("DS-FRAME"), itemName: nameOf("DS-FRAME"), unit: "SET", qty: 1 },
    ],
    additionalCosts: [{ label: "Upholstery labour", amount: 3000 }],
    createdAt: T0,
  };
  const boms = [sizedBom, sofaBom];
  const productions: Production[] = [];
  const bags = new Map<string, Map<number, number>>(
    pieceSorts.map(
      (ps) =>
        [ps.itemId, new Map(ps.pieces.map((x) => [lenKey(x.length), x.count] as const))] as const,
    ),
  );
  const runDates = Array.from({ length: Math.round(12 * scale) }, () => date()).sort();
  for (let i = 0; i < runDates.length; i++) {
    const d = runDates[i];
    const sized = ri(2) === 0;
    const b = sized ? sizedBom : sofaBom;
    const size = { w: 30 + ri(60), h: 30 + ri(80), unit: "in" as const, pieces: 1 + ri(3) };
    const run = sized
      ? consumptionForSize(b, size, size.pieces, byId, { roundUpWhole: true })
      : { lines: consumptionFor(b, 1, byId, true), costs: b.additionalCosts };
    const qty = sized ? madeQty(b, size, size.pieces, "SQFT", 15) : 1;
    const prodId = id("MF");
    const number = num("MFG-", i + 1);
    // Cut the by-length materials from the sizes on hand, as production does.
    const cuts: NonNullable<Production["cuts"]> = [];
    if (sized) {
      const { components } = resolveComponents(b, bomVars(b, size, [], {}, size.pieces), byId);
      for (const comp of components) {
        const it = byId.get(comp.itemId);
        if (!it?.pieces || !comp.cutCount || !comp.cutLength) continue;
        const bag = bags.get(it.id) ?? new Map<number, number>();
        const plan = planCuts(
          Array.from({ length: comp.cutCount * size.pieces }, () => comp.cutLength!),
          [...bag].map(([length, count]) => ({ length, count })),
          { minOffcut: it.pieces.minOffcut, kerf: it.pieces.kerf, loose: 0 },
        );
        for (const t of plan.taken) bag.set(t.length, (bag.get(t.length) ?? 0) - t.count);
        for (const r of plan.returned) bag.set(r.length, (bag.get(r.length) ?? 0) + r.count);
        bags.set(it.id, bag);
        cuts.push({
          itemId: it.id,
          cuts: plan.cuts,
          taken: plan.taken,
          returned: plan.returned,
          scrap: plan.scrap,
          fromLoose: plan.fromLoose,
        });
        const line = run.lines.find((l) => l.itemId === it.id);
        if (line) {
          line.qty = plan.used;
          line.amount = r2(plan.used * line.rate);
        }
        if (plan.scrap > 0.0001)
          stockAdjustments.push({
            id: id("SA"),
            itemId: it.id,
            itemName: it.name,
            date: d,
            type: "reduce",
            qty: plan.scrap,
            kind: "wastage",
            productionId: prodId,
            reason: `Cutting wastage — ${number}`,
            createdAt: createdAt(d),
          } as StockAdjustment);
      }
    }
    const material = r2(run.lines.reduce((a, l) => a + l.amount, 0));
    const add = r2(run.costs.reduce((a, x) => a + x.amount, 0));
    productions.push({
      id: prodId,
      number,
      date: d,
      bomId: b.id,
      bomName: b.name,
      finishedItemId: b.finishedItemId,
      finishedItemName: b.finishedItemName,
      unit: byId.get(b.finishedItemId)!.unit,
      qty,
      components: run.lines,
      additionalCosts: run.costs,
      materialCost: material,
      additionalCost: add,
      totalCost: r2(material + add),
      unitCost: r2((material + add) / (qty || 1)),
      size: sized ? size : undefined,
      cuts: cuts.length ? cuts : undefined,
      createdAt: createdAt(d),
    } as Production);
  }

  /* ── Blind orders measured window by window, and their job cards ── */
  const jobCards: JobCard[] = [];
  {
    const blindItem = byId.get(fixed("DB-BLIND"))!;
    const types = mtm.productTypes ?? [];
    const sides = mtm.operateSides ?? [];
    const stages = (mtm.jobStages ?? []).slice(0, 3); // not yet made
    let serialNo = 1200;
    for (let i = 0; i < Math.round(8 * scale); i++) {
      const party = pick(customers);
      const d = dayAgo(ri(20));
      const kind = ri(2) ? "proforma" : "quotation";
      const windows = 1 + ri(3);
      const lines: LineItem[] = Array.from({ length: windows }, () => {
        const size = { w: 30 + ri(60) + pick([0, 0.25, 0.5]), h: 36 + ri(80), unit: "in" as const };
        const sheet = costSheet(sizedBom, size, byId, (it) => Number(it.purchasePrice) || 0, {
          minSqft: 15,
        });
        const rate = Math.round(sheet.maxRate);
        const qty = r2(sheet.chargeableSqft);
        return {
          id: id("L"),
          itemId: blindItem.id,
          name: blindItem.name,
          qty,
          unit: blindItem.unit,
          price: rate,
          discountPct: 0,
          gstRate: 0,
          amount: r2(qty * rate),
          size: {
            ...size,
            pieces: 1,
            sqft: sheet.sqft,
            chargeableSqft: sheet.chargeableSqft,
            type: pick(types),
            operateSide: pick(sides),
            serial: String(++serialNo),
            note: ri(2)
              ? `${pick(["Kal sanj sudhi", "Somvar sudhi", "Urgent"])} ready kari apva`
              : undefined,
            bomId: sizedBom.id,
          },
        } as LineItem;
      });
      const total = Math.round(lines.reduce((t, l) => t + l.amount, 0));
      const est = {
        id: id("ES"),
        kind,
        status: "open",
        number: num(kind === "quotation" ? "QT-" : "PF-", 100 + i),
        date: d,
        validUntil: dayAgo(-15),
        partyId: party.id,
        partyName: party.name,
        partyPhone: party.phone,
        partyAddress: party.address,
        lineItems: lines,
        subtotal: r2(lines.reduce((t, l) => t + l.amount, 0)),
        discount: 0,
        taxAmount: 0,
        gstEnabled: false,
        taxCalcVersion: 2,
        roundOff: r2(total - lines.reduce((t, l) => t + l.amount, 0)),
        total,
        createdAt: createdAt(d),
      } as Estimate;
      estimates.push(est);
      for (const l of lines) {
        const stage = pick(stages);
        jobCards.push({
          id: id("JC"),
          number: num(mtm.jobPrefix ?? "WB-", jobCards.length + 1),
          date: d,
          dueDate: dayAgo(-(1 + ri(6))),
          stage,
          history: [{ stage, at: createdAt(d) }],
          partyId: party.id,
          partyName: party.name,
          partyPhone: party.phone,
          partyAddress: party.address,
          sourceKind: kind,
          sourceId: est.id,
          sourceNumber: est.number,
          lineId: l.id,
          finishedItemId: blindItem.id,
          finishedItemName: blindItem.name,
          bomId: sizedBom.id,
          size: { w: l.size!.w, h: l.size!.h, unit: l.size!.unit },
          pieces: 1,
          qty: l.qty,
          type: l.size!.type,
          operateSide: l.size!.operateSide,
          serial: l.size!.serial,
          note: l.size!.note,
          assignedTo: pick(["Ramesh", "Suresh", "Mahesh"]),
          createdAt: createdAt(d),
        } as JobCard);
      }
    }
  }

  /* ── Consistent, by the app's own Fix calculations over THESE records ── */
  const data = () => ({
    sales,
    purchases,
    payments,
    banks,
    bankTxns,
    expenses,
    items,
    saleReturns,
    purchaseReturns,
    stockAdjustments,
    productions,
    journalVouchers: journals,
  });
  const plan = planDataRepair(data());
  for (const b of plan.bills) {
    const inv = (b.kind === "sale" ? sales : purchases).find((x) => x.id === b.id);
    if (inv) inv.bankPaidAmount = b.correct;
  }
  for (const corr of plan.items) {
    const it = items.find((x) => x.id === corr.id);
    if (it) it.stock = corr.correct;
  }
  // No real shop runs most of its catalogue below zero. Random sales and
  // production outran random purchases for many items (slats ended at −439),
  // so give each such item enough OPENING stock to cover what it sold, plus
  // some to spare. Opening + movements = stock still holds exactly.
  for (const it of items) {
    const st = Number(it.stock);
    if (!(st < 0)) continue;
    const top = Math.ceil(-st + Math.max(5, -st * 0.25));
    it.openingStock = r2((Number(it.openingStock) || 0) + top);
    it.stock = r2(st + top);
  }
  // By-length items: never more in sizes than in stock. If the dummy runs
  // cut more than the sorted pieces held (from unsorted length that was not
  // there), give the item that much more unsorted OPENING stock.
  {
    const sizedOf = new Map<string, number>();
    const addLen = (id: string, list: PieceCount[] | undefined, sign: number) =>
      sizedOf.set(
        id,
        (sizedOf.get(id) ?? 0) + sign * (list ?? []).reduce((t, x) => t + x.length * x.count, 0),
      );
    for (const ps of pieceSorts) addLen(ps.itemId, ps.pieces, 1);
    for (const pr of productions)
      for (const c of pr.cuts ?? []) {
        addLen(c.itemId, c.taken, -1);
        addLen(c.itemId, c.returned, 1);
      }
    for (const it of items) {
      if (!it.pieces) continue;
      const loose = (Number(it.stock) || 0) - (sizedOf.get(it.id) ?? 0);
      if (loose >= 0) continue;
      const top = Math.ceil(-loose + 10);
      it.openingStock = r2((Number(it.openingStock) || 0) + top);
      it.stock = r2((Number(it.stock) || 0) + top);
    }
  }
  for (const a of planDataRepair(data()).accounts) {
    const bank = banks.find((x) => x.id === a.id);
    if (bank) bank.balance = a.correct;
  }

  return {
    items,
    parties,
    payees,
    banks,
    sales,
    purchases,
    payments,
    saleReturns,
    purchaseReturns,
    expenses,
    cashAdjustments,
    bankTxns,
    journals,
    stockAdjustments,
    estimates,
    boms,
    productions,
    pieceSorts,
    jobCards,
    bsAccounts,
    mtm,
    expenseCategories,
  };
}
