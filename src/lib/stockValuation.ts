/**
 * What the stock was worth on a date — the closing-stock figure of the
 * financial statements.
 *
 * Method: perpetual MOVING WEIGHTED AVERAGE cost, which AS-2 permits for
 * interchangeable goods (fabric by the metre, foam sheets, identical sofas).
 * One chronological pass over every document that moves stock:
 *  - purchases come in at what they cost (line rate after the line discount,
 *    with the bill's own discount and freight spread across its lines; GST
 *    excluded — input credit is recoverable, so it is not cost);
 *  - a production run's finished units come in at what the run consumed
 *    (each material at its average at that moment) plus its labour/overhead;
 *  - everything that goes out (sales, materials consumed, purchase returns,
 *    stock reductions) leaves at the current average, and sale returns /
 *    stock additions come back at it.
 *
 * This is deliberately NOT `item.purchasePrice`: that field is the LAST
 * purchase rate and is overwritten by every purchase, so valuing a past date
 * with it would quietly restate every earlier balance sheet each time the
 * shop buys fabric.
 *
 * Quantities follow exactly the rules stock itself follows (see
 * planStockRepair): adjustment-only notes move nothing.
 *
 * Every statement must take its stock figures from ONE call of this module —
 * opening stock in the Trading account, closing stock there and on the
 * balance sheet — or they stop agreeing with each other.
 */
import type { Invoice, Item, ItemKind, Production, Return, StockAdjustment } from "@/types";

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface StockData {
  items: Item[];
  sales: Invoice[];
  purchases: Invoice[];
  saleReturns: Return[];
  purchaseReturns: Return[];
  stockAdjustments: StockAdjustment[];
  productions: Production[];
}

export interface ItemPosition {
  itemId: string;
  name: string;
  unit: string;
  kind: ItemKind;
  qty: number;
  /** Value at average cost. Never negative: an item oversold below zero is
   *  worth nothing on the balance sheet, not a liability. */
  value: number;
  /** Average cost per unit at that moment. */
  rate: number;
}

export interface StockSnapshot {
  /** "As at" — inclusive. */
  date: string;
  items: ItemPosition[];
  total: number;
  byKind: Record<ItemKind, number>;
}

type Event = {
  date: string;
  created: string;
  rank: number;
  apply: (state: Map<string, Pos>) => void;
};
type Pos = { qty: number; value: number; rate: number };

/** Inward movements first on the same day, so a sale billed the morning the
 *  goods arrived is valued at their cost, not at an empty shelf. A production
 *  sits between: it consumes, then brings its own output in. */
const RANK = {
  purchase: 0,
  saleReturn: 1,
  adjustAdd: 2,
  production: 3,
  sale: 4,
  purchaseReturn: 5,
  adjustReduce: 6,
} as const;

/** Cost per unit of each purchase line: taxable value after the line
 *  discount, with the bill-level discount and freight spread across the
 *  lines in proportion. Round-off is not cost. */
export function purchaseLineRates(inv: Invoice): Map<number, number> {
  const out = new Map<number, number>();
  const taxable = inv.lineItems.map(
    (l) => num(l.qty) * num(l.price) * (1 - num(l.discountPct) / 100),
  );
  const sum = taxable.reduce((s, t) => s + t, 0);
  const factor =
    sum > 0 ? Math.max(0, (sum - num(inv.discount) + num(inv.shippingCharge)) / sum) : 1;
  inv.lineItems.forEach((l, i) => {
    const q = num(l.qty);
    out.set(i, q > 0 ? (taxable[i] * factor) / q : 0);
  });
  return out;
}

/**
 * Stock position (qty and value per item) at the end of each requested date,
 * from one pass. Pass dates as YYYY-MM-DD; "" is not allowed.
 */
export function stockSnapshots(
  data: StockData,
  dates: string[],
  /** When given, receives the cost (rupees) of every sale line and every
   *  physical sale-return line, keyed by lineCostKey — what that line cost
   *  the shop at the moment it moved. */
  lineCosts?: Map<string, number>,
): StockSnapshot[] {
  const items = new Map(data.items.map((i) => [i.id, i] as const));
  const events: Event[] = [];
  /** First known inward rate per item — the fallback for an opening stock
   *  that never had a rate recorded. */
  const firstRate = new Map<string, number>();

  const inAt = (s: Map<string, Pos>, id: string, qty: number, rate: number) => {
    const p = s.get(id) ?? { qty: 0, value: 0, rate: 0 };
    if (p.qty <= 0) {
      // Nothing (or less than nothing) on the shelf: this lot sets the cost.
      p.qty += qty;
      p.rate = rate;
      p.value = p.qty * rate;
    } else {
      p.value += qty * rate;
      p.qty += qty;
      p.rate = p.qty > 0 ? p.value / p.qty : rate;
    }
    s.set(id, p);
  };
  const inAtAverage = (s: Map<string, Pos>, id: string, qty: number): number => {
    const p = s.get(id) ?? { qty: 0, value: 0, rate: 0 };
    const rate = p.rate || num(items.get(id)?.purchasePrice);
    inAt(s, id, qty, rate);
    return qty * rate;
  };
  const out = (s: Map<string, Pos>, id: string, qty: number): number => {
    const p = s.get(id) ?? { qty: 0, value: 0, rate: num(items.get(id)?.purchasePrice) };
    const rate = p.rate || num(items.get(id)?.purchasePrice);
    p.qty -= qty;
    p.rate = rate;
    p.value = p.qty * rate;
    s.set(id, p);
    return qty * rate;
  };

  for (const inv of data.purchases) {
    const rates = purchaseLineRates(inv);
    inv.lineItems.forEach((l, i) => {
      const q = num(l.qty);
      if (!q || !l.itemId) return;
      const rate = rates.get(i) ?? 0;
      if (!firstRate.has(l.itemId)) firstRate.set(l.itemId, rate);
      events.push({
        date: inv.date,
        created: inv.createdAt ?? "",
        rank: RANK.purchase,
        apply: (s) => inAt(s, l.itemId, q, rate),
      });
    });
  }
  for (const r of data.saleReturns) {
    if (r.isAdjustmentOnly) continue;
    r.lineItems.forEach((l, idx) => {
      const q = num(l.qty);
      if (!q || !l.itemId) return;
      events.push({
        date: r.date,
        created: r.createdAt ?? "",
        rank: RANK.saleReturn,
        apply: (s) => {
          const cost = inAtAverage(s, l.itemId, q);
          lineCosts?.set(lineCostKey("saleReturn", r.id, idx), cost);
        },
      });
    });
  }
  for (const r of data.purchaseReturns) {
    if (r.isAdjustmentOnly) continue;
    for (const l of r.lineItems) {
      const q = num(l.qty);
      if (!q || !l.itemId) continue;
      events.push({
        date: r.date,
        created: r.createdAt ?? "",
        rank: RANK.purchaseReturn,
        apply: (s) => void out(s, l.itemId, q),
      });
    }
  }
  for (const inv of data.sales) {
    inv.lineItems.forEach((l, idx) => {
      const q = num(l.qty);
      if (!q || !l.itemId) return;
      events.push({
        date: inv.date,
        created: inv.createdAt ?? "",
        rank: RANK.sale,
        apply: (s) => {
          const cost = out(s, l.itemId, q);
          lineCosts?.set(lineCostKey("sale", inv.id, idx), cost);
        },
      });
    });
  }
  for (const a of data.stockAdjustments) {
    const q = num(a.qty);
    if (!q) continue;
    events.push(
      a.type === "add"
        ? {
            date: a.date,
            created: a.createdAt ?? "",
            rank: RANK.adjustAdd,
            apply: (s) => inAtAverage(s, a.itemId, q),
          }
        : {
            date: a.date,
            created: a.createdAt ?? "",
            rank: RANK.adjustReduce,
            apply: (s) => void out(s, a.itemId, q),
          },
    );
  }
  for (const p of data.productions) {
    const made = num(p.qty);
    if (!made) continue;
    events.push({
      date: p.date,
      created: p.createdAt ?? "",
      rank: RANK.production,
      apply: (s) => {
        let consumed = 0;
        for (const c of p.components ?? []) {
          const q = num(c.qty);
          if (q) consumed += out(s, c.itemId, q);
        }
        const value = consumed + num(p.additionalCost);
        inAt(s, p.finishedItemId, made, value / made);
      },
    });
    if (!firstRate.has(p.finishedItemId)) firstRate.set(p.finishedItemId, num(p.unitCost));
  }

  events.sort(
    (a, b) => a.date.localeCompare(b.date) || a.rank - b.rank || a.created.localeCompare(b.created),
  );

  // Opening stock: before everything, at its recorded rate.
  const state = new Map<string, Pos>();
  for (const it of data.items) {
    const q = num(it.openingStock);
    const rate =
      it.openingRate !== undefined && it.openingRate !== null
        ? num(it.openingRate)
        : (firstRate.get(it.id) ?? num(it.purchasePrice));
    state.set(it.id, { qty: q, value: q * rate, rate });
  }

  const wanted = [...dates].map((d, i) => ({ d, i })).sort((a, b) => a.d.localeCompare(b.d));
  if (lineCosts && !wanted.some((w) => w.d >= "9999-12-31"))
    wanted.push({ d: "9999-12-31", i: -1 });
  const results: StockSnapshot[] = new Array(dates.length);
  let e = 0;
  for (const { d, i } of wanted) {
    while (e < events.length && events[e].date <= d) events[e++].apply(state);
    if (i >= 0) results[i] = snapshot(d, state, items);
  }
  return results;
}

function snapshot(date: string, state: Map<string, Pos>, items: Map<string, Item>): StockSnapshot {
  const out: ItemPosition[] = [];
  const byKind: Record<ItemKind, number> = { trading: 0, raw: 0, finished: 0 };
  let total = 0;
  for (const [id, p] of state) {
    const it = items.get(id);
    const kind: ItemKind = it?.kind ?? "trading";
    const value = r2(Math.max(0, p.value));
    out.push({
      itemId: id,
      name: it?.name ?? "(deleted item)",
      unit: it?.unit ?? "",
      kind,
      qty: r2(p.qty),
      value,
      rate: r2(p.rate),
    });
    byKind[kind] = r2(byKind[kind] + value);
    total += value;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { date, items: out, total: r2(total), byKind };
}

/**
 * Every item's weighted-average cost per unit right now — after every
 * document there is. This is the item's COST (what a sale costs the shop,
 * what stock is worth, what a BOM's materials cost), the way Tally, Zoho and
 * Busy keep it. `Item.purchasePrice` stays what it always was: the LAST
 * purchase rate, kept to pre-fill the next purchase bill.
 */
export function averageCosts(data: StockData): Map<string, number> {
  const [s] = stockSnapshots(data, ["9999-12-31"]);
  return new Map(s.items.map((p) => [p.itemId, p.rate] as const));
}

export const lineCostKey = (kind: "sale" | "saleReturn", docId: string, lineIndex: number) =>
  `${kind}:${docId}:${lineIndex}`;

/**
 * What every sale line (and every goods-returned line) cost the shop, at the
 * weighted average of the moment it moved — derived from the books, never
 * stored. Editing or deleting a purchase, a production run or a stock
 * adjustment therefore re-costs every later sale on its own, exactly as Tally
 * does; a cost frozen onto the bill when it was saved could not.
 */
export function saleLineCosts(data: StockData): Map<string, number> {
  const costs = new Map<string, number>();
  stockSnapshots(data, ["9999-12-31"], costs);
  return costs;
}

/** Cost of goods sold for a set of sales and sale returns (already filtered
 *  to the period): sale lines at their cost, less physical returns at the
 *  cost they came back at. A line the books cannot cost (no item) falls back
 *  to the cost snapshot saved on it. */
export function cogsOf(
  sales: Invoice[],
  saleReturns: Return[],
  costs: Map<string, number>,
): number {
  let total = 0;
  for (const inv of sales)
    inv.lineItems.forEach((l, i) => {
      total += costs.get(lineCostKey("sale", inv.id, i)) ?? num(l.costPrice) * num(l.qty);
    });
  for (const r of saleReturns) {
    if (r.isAdjustmentOnly) continue;
    r.lineItems.forEach((l, i) => {
      total -= costs.get(lineCostKey("saleReturn", r.id, i)) ?? num(l.costPrice) * num(l.qty);
    });
  }
  return r2(total);
}
