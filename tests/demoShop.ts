/**
 * A dummy M Décor — a whole business's worth of data for testing every page
 * at a realistic size, in the TEST browser only (the screen-test harness has
 * no route to the live Firestore; see tests/stubs/firebase.ts).
 *
 * Sofas, curtains and blinds; ~two years of trading; every kind of document:
 * sales (cash / bank / split / credit, GST on and off), purchases, payments
 * with bill allocations and advances, sale & purchase returns, expenses,
 * journal vouchers, cash and bank entries, stock adjustments, quotations and
 * proformas, BOMs (fixed and made-to-measure), production runs, payees,
 * balance-sheet register accounts, and Settings → Manufacturing filled in.
 *
 * Generated, then made CONSISTENT the way the shop would: by running the
 * app's own Fix calculations over it once (planDataRepair) — so stock, bank
 * balances and bank-paid amounts are exactly what the documents say.
 */
import type {
  BankAccount,
  Bom,
  Estimate,
  Expense,
  Invoice,
  Item,
  JournalVoucher,
  LineItem,
  Party,
  Payment,
  Production,
  Return,
} from "@/types";
import {
  PartyRepo,
  ItemRepo,
  SalesRepo,
  PurchaseRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  ExpenseRepo,
  PayeeRepo,
  BankRepo,
  BankTxnRepo,
  PaymentRepo,
  CompanyRepo,
  StockAdjustmentRepo,
  EstimateRepo,
  CashAdjustmentRepo,
  BomRepo,
  ProductionRepo,
  BsAccountRepo,
  FinConfigRepo,
  JournalVoucherRepo,
} from "@/repositories";
import { planDataRepair } from "@/lib/dataRepair";
import { consumptionFor } from "@/lib/production";
import { consumptionForSize, madeQty } from "@/lib/sizing";
import { ymd } from "@/lib/format";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface DemoCounts {
  items: number;
  parties: number;
  sales: number;
  purchases: number;
  payments: number;
  expenses: number;
  returns: number;
  estimates: number;
  journals: number;
  productions: number;
  boms: number;
}

export function seedDemoShop(opts: { scale?: number; seed?: number } = {}): DemoCounts {
  const scale = opts.scale ?? 1;
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
  const id = (p: string) => `${p}-${++serial}`;

  // Dates: the last ~22 months, weighted to recent ones, and plenty in the
  // CURRENT month so every "this month" list has rows.
  const today = new Date();
  const dayAgo = (n: number) => ymd(new Date(today.getTime() - n * 86400000));
  const date = () => (ri(3) === 0 ? dayAgo(ri(Math.max(1, today.getDate()))) : dayAgo(ri(660)));
  const createdAt = (d: string) =>
    `${d}T${String(9 + ri(10)).padStart(2, "0")}:${String(ri(60)).padStart(2, "0")}:00Z`;

  /* ── Settings ─────────────────────────────────────────────────────── */
  CompanyRepo.save({
    name: "M DÉCOR",
    gstin: "24AAACC1234D1ZI",
    phone: "9558945607",
    address: "Ring Road, Surat",
    currency: "INR",
    invoicePrefix: "INV-",
    purchasePrefix: "PUR-",
    enableGst: true,
    allowNegativeStock: true,
    expenseCategories: [
      "Rent",
      "Karigar wages",
      "Transport",
      "Electricity",
      "Tea & snacks",
      "Freight",
    ],
    units: ["PCS", "MTR", "FT", "SQFT", "SET", "ROLL", "KG"],
    mtm: {
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
    },
  } as never);

  /* ── Banks ────────────────────────────────────────────────────────── */
  const banks: BankAccount[] = [
    {
      id: "BANK-HDFC",
      name: "HDFC Current",
      openingBalance: 150000,
      balance: 0,
      createdAt: "2025-01-01T00:00:00Z",
    },
    {
      id: "BANK-SBI",
      name: "SBI Savings",
      openingBalance: 40000,
      balance: 0,
      createdAt: "2025-01-01T00:00:00Z",
    },
  ] as never;
  banks.forEach((b) => BankRepo.add(b as never));

  /* ── Items ────────────────────────────────────────────────────────── */
  const items: Item[] = [];
  const addItem = (p: Partial<Item> & { name: string }) => {
    const it = {
      id: p.id ?? id("IT"),
      unit: "PCS",
      gstRate: 18,
      purchasePrice: 100,
      salePrice: 150,
      stock: 0,
      openingStock: 0,
      createdAt: "2025-01-01T00:00:00Z",
      ...p,
    } as Item;
    items.push(it);
    ItemRepo.add(it as never);
    return it;
  };
  // The blinds hardware the client's sheet uses.
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
  for (const [iid, name, unit, price] of blindRaw)
    addItem({
      id: iid,
      name,
      unit,
      kind: "raw",
      purchasePrice: price,
      salePrice: r2(price * 1.4),
      openingStock: 400,
      gstRate: 18,
      category: "Blind hardware",
    });
  addItem({
    id: "DB-BLIND",
    name: "Wooden Blind Easy Lift",
    unit: "SQFT",
    kind: "finished",
    purchasePrice: 0,
    salePrice: 480,
    gstRate: 12,
    category: "Blinds",
  });
  addItem({
    id: "DB-ROLLER",
    name: "Roller Blind Blackout",
    unit: "SQFT",
    kind: "finished",
    purchasePrice: 0,
    salePrice: 160,
    gstRate: 12,
    category: "Blinds",
  });
  // Sofa side.
  addItem({
    id: "DS-FAB",
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
    id: "DS-FOAM",
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
    id: "DS-FRAME",
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
    id: "DS-SOFA3",
    name: "Sofa 3 Seater Royal",
    unit: "PCS",
    kind: "finished",
    purchasePrice: 0,
    salePrice: 32000,
    gstRate: 18,
    category: "Sofa",
  });
  addItem({
    id: "DS-SOFA2",
    name: "Sofa 2 Seater",
    unit: "PCS",
    kind: "finished",
    purchasePrice: 0,
    salePrice: 22000,
    gstRate: 18,
    category: "Sofa",
  });
  // Curtain fabrics and trading goods — the bulk of the catalogue.
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
  const nFab = Math.round(60 * scale);
  for (let i = 0; i < nFab; i++) {
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
  const nTrade = Math.round(60 * scale);
  for (let i = 0; i < nTrade; i++) {
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
  // Messy records an import or an old app leaves behind.
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

  /* ── Parties ──────────────────────────────────────────────────────── */
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
    const gst = ri(3) === 0;
    const p = {
      id: id("PT"),
      name: `${pick(firstNames)} ${pick(kinds)} ${i + 1}`,
      type,
      phone: `9${String(100000000 + ri(899999999))}`,
      gstin: gst ? (ri(4) ? "24AAACC1234D1ZI" : "27AAACC1234D1ZC") : undefined,
      state: gst ? undefined : "Gujarat",
      city: pick(["Surat", "Ahmedabad", "Vadodara", "Navsari", "Mumbai"]),
      address: `${1 + ri(300)}, ${pick(["Ring Road", "Station Road", "Adajan", "Varachha", "Vesu"])}`,
      openingBalance: ri(4) === 0 ? r2((rnd() - 0.4) * 30000) : 0,
      createdAt: "2025-01-01T00:00:00Z",
    } as Party;
    parties.push(p);
    PartyRepo.add(p as never);
  }
  const customers = parties.filter((p) => p.type !== "supplier");
  const suppliers = parties.filter((p) => p.type !== "customer");
  for (const n of ["Ramesh Karigar", "Landlord Shah", "GEB Electricity", "Tempo Raju", "Chai Wala"])
    PayeeRepo.add({ id: id("PY"), name: n, createdAt: "2025-01-01T00:00:00Z" } as never);

  /* ── Bills ────────────────────────────────────────────────────────── */
  const sellable = items.filter((i) => i.kind !== "raw" || ri(4) === 0);
  const buyable = items.filter((i) => i.kind !== "finished");
  let saleNo = 0;
  let purNo = 0;
  const makeBill = (isSale: boolean): Invoice => {
    const party = pick(isSale ? customers : suppliers);
    const gstOn = ri(5) > 0;
    const d = date();
    const lines: LineItem[] = Array.from({ length: 1 + ri(4) }, () => {
      const it = pick(isSale ? sellable : buyable);
      const qty = it.unit === "MTR" ? r2(1 + rnd() * 25) : 1 + ri(6);
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
    const inv = {
      id: id(isSale ? "S" : "P"),
      number: isSale
        ? `INV-${String(++saleNo).padStart(4, "0")}`
        : `PUR-${String(++purNo).padStart(4, "0")}`,
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
            { mode: "bank", amount: r2(paid - r2(paid / 2)), bankId: "BANK-HDFC" },
          ]
        : undefined,
      createdAt: createdAt(d),
    } as Invoice;
    return inv;
  };
  const sales = Array.from({ length: Math.round(300 * scale) }, () => makeBill(true));
  const purchases = Array.from({ length: Math.round(120 * scale) }, () => makeBill(false));

  /* ── Payments: settle bills (some with discount), and advances ───── */
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
      const d =
        inv.date > dayAgo(5)
          ? inv.date
          : dayAgo(
              ri(
                Math.max(
                  1,
                  Math.floor((today.getTime() - new Date(inv.date).getTime()) / 86400000),
                ),
              ),
            );
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

  /* ── Returns ──────────────────────────────────────────────────────── */
  const saleReturns: Return[] = [];
  const purchaseReturns: Return[] = [];
  let srNo = 0;
  let prNo = 0;
  for (let i = 0; i < Math.round(25 * scale); i++) {
    const isSale = ri(3) > 0;
    const src = pick(isSale ? sales : purchases);
    const l = src.lineItems[0];
    const qty = l.unit === "MTR" ? r2(Math.min(l.qty, 1 + rnd() * 3)) : 1;
    const taxable = r2(qty * l.price * (1 - l.discountPct / 100));
    const tax = src.gstEnabled ? r2((taxable * l.gstRate) / 100) : 0;
    const total = Math.round(taxable + tax);
    const d = src.date > dayAgo(3) ? src.date : dayAgo(ri(30));
    const r = {
      id: id(isSale ? "SR" : "PR"),
      number: isSale
        ? `SR-${String(++srNo).padStart(4, "0")}`
        : `PR-${String(++prNo).padStart(4, "0")}`,
      date: d,
      partyId: src.partyId,
      partyName: src.partyName,
      originalRef: src.number,
      reason: pick(["damaged", "wrong_item", "other"]),
      lineItems: [{ ...l, id: id("L"), qty, amount: r2(taxable + tax) }],
      subtotal: taxable,
      taxAmount: tax,
      gstEnabled: src.gstEnabled,
      total,
      createdAt: createdAt(d),
    } as unknown as Return;
    (isSale ? saleReturns : purchaseReturns).push(r);
  }

  /* ── Expenses ─────────────────────────────────────────────────────── */
  const expenses: Expense[] = [];
  for (let i = 0; i < Math.round(90 * scale); i++) {
    const d = date();
    const bank = ri(4) === 0 ? pick(banks).id : undefined;
    expenses.push({
      id: id("EX"),
      date: d,
      category: pick([
        "Rent",
        "Karigar wages",
        "Transport",
        "Electricity",
        "Tea & snacks",
        "Freight",
      ]),
      amount: r2(100 + ri(15000)),
      paymentMode: bank ? "bank" : "cash",
      bankId: bank,
      payeeName: ri(2) ? pick(["Ramesh Karigar", "Landlord Shah", "Tempo Raju"]) : undefined,
      createdAt: createdAt(d),
    } as Expense);
  }

  /* ── Cash & bank entries, journals ────────────────────────────────── */
  for (let i = 0; i < Math.round(10 * scale); i++) {
    const d = date();
    CashAdjustmentRepo.add({
      id: id("CA"),
      date: d,
      type: pick(["add", "reduce"]),
      amount: r2(2000 + ri(20000)),
      reason: pick(["Owner put in", "Owner took", "Petty cash"]),
      createdAt: createdAt(d),
    } as never);
    BankTxnRepo.add({
      id: id("BT"),
      bankId: pick(banks).id,
      date: d,
      type: pick(["deposit", "withdraw"]),
      amount: r2(5000 + ri(40000)),
      note: "Counter",
      createdAt: createdAt(d),
    } as never);
  }
  const journals: JournalVoucher[] = [];
  for (let i = 0; i < Math.round(8 * scale); i++) {
    const d = date();
    const name = pick(["Capital", "Drawings", "HDFC Car Loan", "Machinery"]);
    const amt = r2(5000 + ri(80000));
    const dr = name === "Drawings" || name === "Machinery";
    journals.push({
      id: id("JV"),
      number: `JV-${String(i + 1).padStart(4, "0")}`,
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
          refId: "BANK-HDFC",
          refName: "HDFC Current",
          debit: dr ? 0 : amt,
          credit: dr ? amt : 0,
        },
      ],
    } as JournalVoucher);
  }
  BsAccountRepo.add({
    id: "BS-CAP",
    name: "Capital",
    group: "capital",
    openingBalance: 500000,
    openingSide: "cr",
    createdAt: "2025-01-01T00:00:00Z",
  } as never);
  BsAccountRepo.add({
    id: "BS-DRW",
    name: "Drawings",
    group: "drawings",
    createdAt: "2025-01-01T00:00:00Z",
  } as never);
  BsAccountRepo.add({
    id: "BS-LOAN",
    name: "HDFC Car Loan",
    group: "securedLoan",
    openingBalance: 300000,
    openingSide: "cr",
    createdAt: "2025-01-01T00:00:00Z",
  } as never);
  BsAccountRepo.add({
    id: "BS-MACH",
    name: "Machinery",
    group: "fixedAsset",
    openingBalance: 120000,
    openingSide: "dr",
    depreciationRate: 15,
    createdAt: "2025-01-01T00:00:00Z",
  } as never);
  FinConfigRepo.add({
    id: "config",
    expenseClass: { Freight: "direct", "Karigar wages": "direct" },
    createdAt: "2025-01-01T00:00:00Z",
  } as never);

  /* ── Stock adjustments ────────────────────────────────────────────── */
  for (let i = 0; i < Math.round(15 * scale); i++) {
    const it = pick(items);
    const d = date();
    StockAdjustmentRepo.add({
      id: id("SA"),
      itemId: it.id,
      itemName: it.name,
      date: d,
      type: pick(["add", "reduce"]),
      qty: 1 + ri(5),
      reason: pick(["Damaged", "Count correction", "Sample"]),
      createdAt: createdAt(d),
    } as never);
  }

  /* ── Quotations & proformas ───────────────────────────────────────── */
  const estimates: Estimate[] = [];
  for (let i = 0; i < Math.round(30 * scale); i++) {
    const b = makeBill(true);
    const kind = ri(2) ? "quotation" : "proforma";
    estimates.push({
      id: id("ES"),
      kind,
      status: pick(["open", "open", "converted", "cancelled"]),
      number: `${kind === "quotation" ? "QT" : "PF"}-${String(i + 1).padStart(4, "0")}`,
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
  saleNo -= Math.round(30 * scale); // estimates borrowed bill numbers; give them back

  /* ── BOMs & production ────────────────────────────────────────────── */
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const sizedBom: Bom = {
    id: "BOM-EASY",
    name: "Wooden Blind — Easy Lift",
    finishedItemId: "DB-BLIND",
    finishedItemName: "Wooden Blind Easy Lift",
    outputQty: 1,
    components: [
      {
        itemId: "DB-BOT",
        itemName: "Bottom rail",
        unit: "MTR",
        qty: 0,
        qtyFormula: "W",
        resultUnit: "in",
      },
      {
        itemId: "DB-SLT",
        itemName: "Slat 50mm Wooden",
        unit: "PCS",
        qty: 0,
        qtyFormula: "CEIL(H / SLAT_PITCH)",
      },
      {
        itemId: "DB-HR",
        itemName: "Head rail",
        unit: "FT",
        qty: 0,
        qtyFormula: "W",
        resultUnit: "in",
      },
      { itemId: "DB-MEC", itemName: "Mechanism Easy Lift", unit: "PCS", qty: 0, qtyFormula: "2" },
      {
        itemId: "DB-ATR",
        itemName: "ATR",
        unit: "PCS",
        qty: 0,
        qtyFormula: "CEIL(W / LADDER_GAP)",
      },
      { itemId: "DB-CHN", itemName: "Chain", unit: "PCS", qty: 0, qtyFormula: "1" },
      {
        itemId: "DB-LT",
        itemName: "Ladder tape",
        unit: "PCS",
        qty: 0,
        qtyFormula: "CEIL(W / LADDER_GAP)",
      },
      { itemId: "DB-ROD", itemName: "Rod", unit: "FT", qty: 0, qtyFormula: "W", resultUnit: "in" },
      { itemId: "DB-CB", itemName: "Ceiling bracket", unit: "PCS", qty: 0, qtyFormula: "2" },
      {
        itemId: "DB-DOR",
        itemName: "Dori (andar ni)",
        unit: "PCS",
        qty: 0,
        qtyFormula: "CEIL(W / LADDER_GAP)",
      },
      {
        itemId: "DB-BL",
        itemName: "Bottom lock",
        unit: "PCS",
        qty: 0,
        qtyFormula: "CEIL(W / LADDER_GAP)",
      },
    ],
    additionalCosts: [{ label: "Karigar labour", amount: 350 }],
    sizing: {
      formulaUnit: "in",
      pricing: {
        basis: "sqft",
        minSqft: 15,
        addPerUnit: 47,
        minMarginPct: 10,
        maxMarginPct: 54,
        roundLines: "up",
      },
    },
    createdAt: "2025-01-01T00:00:00Z",
  };
  const sofaBom: Bom = {
    id: "BOM-SOFA3",
    name: "Sofa 3 Seater Royal",
    finishedItemId: "DS-SOFA3",
    finishedItemName: "Sofa 3 Seater Royal",
    outputQty: 1,
    components: [
      {
        itemId: "DS-FAB",
        itemName: "Velvet Fabric Royal Blue",
        unit: "MTR",
        qty: 12,
        wastagePct: 5,
      },
      { itemId: "DS-FOAM", itemName: 'Foam Sheet 4" HD', unit: "PCS", qty: 4 },
      { itemId: "DS-FRAME", itemName: "Wooden Frame 3 Seater", unit: "SET", qty: 1 },
    ],
    additionalCosts: [{ label: "Upholstery labour", amount: 3000 }],
    createdAt: "2025-01-01T00:00:00Z",
  };
  const boms = [sizedBom, sofaBom];
  boms.forEach((b) => BomRepo.add(b as never));
  const constants = [
    { key: "SLAT_PITCH", value: 1.13 },
    { key: "LADDER_GAP", value: 24 },
  ];
  const productions: Production[] = [];
  for (let i = 0; i < Math.round(12 * scale); i++) {
    const d = date();
    const sized = ri(2) === 0;
    const b = sized ? sizedBom : sofaBom;
    const size = { w: 30 + ri(60), h: 30 + ri(80), unit: "in" as const, pieces: 1 + ri(3) };
    const run = sized
      ? consumptionForSize(b, size, size.pieces, byId, { constants, roundUpWhole: true })
      : { lines: consumptionFor(b, 1, byId, true), costs: b.additionalCosts };
    const qty = sized ? madeQty(b, size, size.pieces, "SQFT", 15) : 1;
    const material = r2(run.lines.reduce((a, l) => a + l.amount, 0));
    const add = r2(run.costs.reduce((a, c) => a + c.amount, 0));
    productions.push({
      id: id("MF"),
      number: `MFG-${String(i + 1).padStart(4, "0")}`,
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
      createdAt: createdAt(d),
    } as Production);
  }

  /* ── Store, then make consistent with the app's own repair ─────────── */
  sales.forEach((x) => SalesRepo.add(x as never));
  purchases.forEach((x) => PurchaseRepo.add(x as never));
  payments.forEach((x) => PaymentRepo.add(x as never));
  saleReturns.forEach((x) => SaleReturnRepo.add(x as never));
  purchaseReturns.forEach((x) => PurchaseReturnRepo.add(x as never));
  expenses.forEach((x) => ExpenseRepo.add(x as never));
  journals.forEach((x) => JournalVoucherRepo.add(x as never));
  estimates.forEach((x) => EstimateRepo.add(x as never));
  productions.forEach((x) => ProductionRepo.add(x as never));

  const plan = planDataRepair({
    sales: SalesRepo.all(),
    purchases: PurchaseRepo.all(),
    payments: PaymentRepo.all(),
    banks: BankRepo.all(),
    bankTxns: BankTxnRepo.all(),
    expenses: ExpenseRepo.all(),
    items: ItemRepo.all(),
    saleReturns: SaleReturnRepo.all(),
    purchaseReturns: PurchaseReturnRepo.all(),
    stockAdjustments: StockAdjustmentRepo.all(),
    productions: ProductionRepo.all(),
    journalVouchers: JournalVoucherRepo.all(),
  });
  for (const b of plan.bills)
    (b.kind === "sale" ? SalesRepo : PurchaseRepo).update(b.id, {
      bankPaidAmount: b.correct,
    } as never);
  for (const c of plan.items) ItemRepo.update(c.id, { stock: c.correct } as never);
  // Bank balances depend on the corrected bank-paid amounts — plan again.
  const plan2 = planDataRepair({
    sales: SalesRepo.all(),
    purchases: PurchaseRepo.all(),
    payments: PaymentRepo.all(),
    banks: BankRepo.all(),
    bankTxns: BankTxnRepo.all(),
    expenses: ExpenseRepo.all(),
    items: ItemRepo.all(),
    saleReturns: SaleReturnRepo.all(),
    purchaseReturns: PurchaseReturnRepo.all(),
    stockAdjustments: StockAdjustmentRepo.all(),
    productions: ProductionRepo.all(),
    journalVouchers: JournalVoucherRepo.all(),
  });
  for (const a of plan2.accounts) BankRepo.update(a.id, { balance: a.correct } as never);

  return {
    items: items.length,
    parties: parties.length,
    sales: sales.length,
    purchases: purchases.length,
    payments: payments.length,
    expenses: expenses.length,
    returns: saleReturns.length + purchaseReturns.length,
    estimates: estimates.length,
    journals: journals.length,
    productions: productions.length,
    boms: boms.length,
  };
}
