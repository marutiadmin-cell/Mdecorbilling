/**
 * Pieces by size, for by-length items (slats, rails, rods) — REPLAYED from
 * the documents in date order, never stored as a balance, so an edit or a
 * delete anywhere is reflected at once and the sizes can never claim more
 * length than the stock holds.
 *
 * Every movement of the item, oldest first:
 *   opening stock, a purchase, a sale return,
 *   a stock adjustment (add) without pieces ......... into UNSORTED
 *   a stock adjustment (add/remove) WITH pieces ...... those sizes, in/out
 *   a piece sort ..................................... unsorted → sizes
 *   a production run that recorded its cuts ......... exactly those pieces
 *                                                      out, offcuts back in
 *   a sale, a purchase return, a stock removal or
 *   a production line that names no pieces ........... unsorted first, then
 *       the smallest piece it fits in (the rest of that piece stays a size),
 *       or whole pieces, longest first, when no single piece is long enough
 * Cutting scrap is part of a run's cuts, so its wastage adjustment is not
 * replayed again.
 */
import type {
  Invoice,
  Item,
  PieceCount,
  PieceSort,
  Production,
  Return,
  StockAdjustment,
} from "@/types";
import { lenKey, piecesLength } from "@/lib/cutting";

export interface PieceData {
  stockAdjustments: StockAdjustment[];
  pieceSorts: PieceSort[];
  productions: Production[];
  sales?: Invoice[];
  purchases?: Invoice[];
  saleReturns?: Return[];
  purchaseReturns?: Return[];
}

export interface Bags {
  /** Sizes on hand, longest first. */
  pieces: PieceCount[];
  /** Total length in sizes. */
  sized: number;
  /** Length in stock not in any size. Negative only when more went out than
   *  the documents ever brought in (stock below zero). */
  loose: number;
}

type State = { sizes: Map<number, number>; loose: number };
type Ev = { date: string; created: string; rank: number; apply: () => void };

const inc = (st: State, len: number, n: number) => {
  const k = lenKey(len);
  if (!(k > 0) || !n) return;
  const v = (st.sizes.get(k) ?? 0) + n;
  if (v === 0) st.sizes.delete(k);
  else st.sizes.set(k, v);
};

/** Length leaving stock with no pieces named: unsorted first, then pieces. */
function take(st: State, qty: number) {
  let r = lenKey(Number(qty) || 0);
  if (!(r > 0)) return;
  const fromLoose = Math.min(Math.max(0, st.loose), r);
  st.loose = lenKey(st.loose - fromLoose);
  r = lenKey(r - fromLoose);
  while (r > 0.00005) {
    const on = [...st.sizes].filter(([, c]) => c > 0).sort((a, b) => a[0] - b[0]);
    if (!on.length) {
      st.loose = lenKey(st.loose - r);
      return;
    }
    const fit = on.find(([len]) => len + 1e-9 >= r);
    if (fit) {
      inc(st, fit[0], -1);
      const left = lenKey(fit[0] - r);
      if (left > 0.00005) inc(st, left, 1);
      return;
    }
    const [longest] = on[on.length - 1];
    inc(st, longest, -1);
    r = lenKey(r - longest);
  }
}

/** Every by-length item's sizes at once — one pass over the documents. */
export function allBags(
  items: Pick<Item, "id" | "stock" | "pieces" | "openingStock">[],
  data: PieceData,
  opts: { excludeProductionId?: string } = {},
): Map<string, Bags> {
  const tracked = new Map(items.filter((i) => i.pieces).map((i) => [i.id, i] as const));
  const out = new Map<string, Bags>();
  if (!tracked.size) return out;
  const states = new Map<string, State>();
  for (const it of tracked.values())
    states.set(it.id, { sizes: new Map(), loose: lenKey(Number(it.openingStock) || 0) });
  const evs: Ev[] = [];
  const on = (
    itemId: string,
    date: string,
    created: string | undefined,
    rank: number,
    fn: (st: State) => void,
  ) => {
    const st = states.get(itemId);
    // A record with no date (old or imported data) sorts first, not crash.
    if (st) evs.push({ date: date ?? "", created: created ?? "", rank, apply: () => fn(st) });
  };
  // Same-day order: things coming in, then sorting, then things going out.
  const IN = 0;
  const SORT = 1;
  const OUT = 2;

  for (const s of data.pieceSorts)
    on(s.itemId, s.date, s.createdAt, SORT, (st) => {
      for (const p of s.pieces) inc(st, p.length, p.count);
      st.loose = lenKey(st.loose - piecesLength(s.pieces));
    });
  for (const a of data.stockAdjustments) {
    if (a.kind === "wastage" && a.productionId) continue; // inside the run's cuts
    const rank = a.type === "add" ? IN : OUT;
    on(a.itemId, a.date, a.createdAt, rank, (st) => {
      if (a.pieces?.length)
        for (const p of a.pieces) inc(st, p.length, a.type === "add" ? p.count : -p.count);
      else if (a.type === "add") st.loose = lenKey(st.loose + (Number(a.qty) || 0));
      else take(st, a.qty);
    });
  }
  for (const p of data.productions) {
    if (p.id === opts.excludeProductionId) continue;
    on(p.finishedItemId, p.date, p.createdAt, IN, (st) => {
      st.loose = lenKey(st.loose + (Number(p.qty) || 0));
    });
    const cutItems = new Set((p.cuts ?? []).map((c) => c.itemId));
    for (const c of p.cuts ?? [])
      on(c.itemId, p.date, p.createdAt, OUT, (st) => {
        for (const t of c.taken) inc(st, t.length, -t.count);
        for (const r of c.returned) inc(st, r.length, r.count);
        st.loose = lenKey(st.loose - (Number(c.fromLoose) || 0));
      });
    for (const l of p.components ?? [])
      if (!cutItems.has(l.itemId)) on(l.itemId, p.date, p.createdAt, OUT, (st) => take(st, l.qty));
  }
  const lines = (
    docs: (Invoice | Return)[] | undefined,
    rank: number,
    fn: (st: State, qty: number) => void,
  ) => {
    for (const d of docs ?? []) {
      if ((d as Return).isAdjustmentOnly) continue;
      for (const l of d.lineItems ?? [])
        on(l.itemId, d.date, d.createdAt, rank, (st) => fn(st, Number(l.qty) || 0));
    }
  };
  const into = (st: State, q: number) => {
    st.loose = lenKey(st.loose + q);
  };
  lines(data.purchases, IN, into);
  lines(data.saleReturns, IN, into);
  lines(data.sales, OUT, take);
  lines(data.purchaseReturns, OUT, take);

  evs.sort(
    (a, b) => a.date.localeCompare(b.date) || a.rank - b.rank || a.created.localeCompare(b.created),
  );
  for (const e of evs) e.apply();

  for (const [id, st] of states) {
    const pieces = [...st.sizes]
      .filter(([, count]) => count !== 0)
      .map(([length, count]) => ({ length, count }))
      .sort((a, b) => b.length - a.length);
    out.set(id, { pieces, sized: piecesLength(pieces), loose: lenKey(st.loose) });
  }
  return out;
}

/** One item's sizes. */
export function bagsOf(
  item: Pick<Item, "id" | "stock" | "pieces" | "openingStock">,
  data: PieceData,
  opts?: { excludeProductionId?: string },
): Bags {
  return (
    allBags([item], data, opts).get(item.id) ?? {
      pieces: [],
      sized: 0,
      loose: Number(item.stock) || 0,
    }
  );
}

/** "20 ft × 2, 10 ft × 1" */
export function piecesLabel(pieces: PieceCount[], unit: string): string {
  if (!pieces.length) return "—";
  return pieces
    .filter((p) => p.count)
    .map((p) => `${fmtLen(p.length)} ${unit} × ${p.count}`)
    .join(", ");
}

export const fmtLen = (n: number) => String(Math.round(n * 100) / 100);

/** What is wrong with the sizes of by-length items: a size below zero, or
 *  more length in sizes than in stock. Empty when all is well. */
export function sizeProblems(
  items: Pick<Item, "id" | "name" | "unit" | "stock" | "pieces" | "openingStock">[],
  data: PieceData,
  opts?: { excludeProductionId?: string },
): string[] {
  const bags = allBags(items, data, opts);
  const out: string[] = [];
  for (const it of items) {
    const b = bags.get(it.id);
    if (!b) continue;
    for (const p of b.pieces)
      if (p.count < 0) out.push(`${it.name}: ${fmtLen(p.length)} ${it.unit} pieces (${p.count})`);
    if (b.loose < -0.01)
      out.push(`${it.name}: ${fmtLen(-b.loose)} ${it.unit} more in sizes than in stock`);
  }
  return out;
}

/**
 * Would this change break the sizes? A by-length item's offcut can be cut
 * again by a LATER run, and its sorted length can come from a purchase — so
 * deleting the earlier document would leave the later one using pieces that
 * no longer exist. Returns the NEW problems the change would create (what
 * is already wrong does not block an unrelated change), naming what to
 * delete first when it can.
 */
export function sizeBreaksIf(
  items: Pick<Item, "id" | "name" | "unit" | "stock" | "pieces" | "openingStock">[],
  now: PieceData,
  after: PieceData,
): string[] {
  const before = new Set(sizeProblems(items, now));
  return sizeProblems(items, after).filter((p) => !before.has(p));
}
