/**
 * Manufacturing: how a production run moves stock, and what it costs.
 *
 * A production run is the one document that moves stock both ways at once —
 * finished units in, materials out — so every place that rebuilds or lists
 * stock (Fix calculations, Inventory, the item history) reads it through
 * `productionMovements` rather than repeating the arithmetic. If those
 * readers ever disagree with what a save posted, "Fix calculations" would
 * quietly undo real production.
 */
import type { Production } from "@/types";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface StockMove {
  itemId: string;
  /** Signed: positive comes in, negative goes out. */
  qty: number;
}

/** Every stock movement a production run posted: the finished item +qty,
 *  each material −qty (the run's TOTAL, as stored). The same item may appear
 *  more than once (a material listed twice); readers simply add them. */
export function productionMovements(
  p: Pick<Production, "finishedItemId" | "qty" | "components">,
): StockMove[] {
  const moves: StockMove[] = [{ itemId: p.finishedItemId, qty: r2(Number(p.qty) || 0) }];
  for (const c of p.components ?? []) {
    moves.push({ itemId: c.itemId, qty: -r2(Number(c.qty) || 0) });
  }
  return moves;
}
