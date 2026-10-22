/**
 * Manufacturing: how a production run moves stock, and what it costs.
 *
 * A production run is the one document that moves stock both ways at once —
 * finished units in, materials out — so every place that rebuilds or lists
 * stock (Fix calculations, Inventory, the item history) reads it through
 * `productionMovements` rather than repeating the arithmetic. If those
 * readers ever disagree with what a save posted, "Fix calculations" would
 * quietly undo real production.
 *
 * Costing follows Tally's Manufacturing Journal: each material's quantity is
 * the BOM's quantity × units made ÷ the BOM's output (plus wastage), at the
 * material's cost; labour and overhead are added on top; the finished item's
 * cost becomes this run's cost per unit — the same "last cost" rule a
 * purchase follows when it overwrites an item's purchase price.
 */
import type { Bom, CostLine, Item, ItemKind, Production, ProductionLine } from "@/types";

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** What an item is to the business — see ItemKind. Raw materials feed a BOM;
 *  finished goods are made from one; trading goods are bought and sold. */
export const ITEM_KIND_OPTIONS: { value: ItemKind; label: string }[] = [
  { value: "trading", label: "Trading goods" },
  { value: "raw", label: "Raw material" },
  { value: "finished", label: "Finished good (manufactured)" },
];

/** A BOM or production past this many materials is not a recipe anyone types
 *  — and every material is a write in the run's single atomic batch
 *  (Firestore caps one at 500; an edit writes each material twice). */
export const MAX_BOM_COMPONENTS = 150;

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
  const moves: StockMove[] = [{ itemId: p.finishedItemId, qty: r2(num(p.qty)) }];
  for (const c of p.components ?? []) {
    moves.push({ itemId: c.itemId, qty: -r2(num(c.qty)) });
  }
  return moves;
}

/** Units that can only be whole — a run cannot use 2.4 foam sheets of a
 *  sheet-counted foam or 1.2 frames. Fabric (MTR), foam by weight (KGS) etc.
 *  stay decimal. Used to offer a round-up, never to force one. */
const WHOLE_UNITS = new Set(["PCS", "NOS", "SET", "BOX", "BAG", "PAIR", "UNIT", "UNITS", "PC"]);
export const isWholeUnit = (unit: string) => WHOLE_UNITS.has((unit || "").trim().toUpperCase());

/** How much of each material making `qty` finished units takes, by the BOM:
 *  qty × perOutput ÷ outputQty × (1 + wastage%), rounded to 2 decimals — the
 *  precision stock is kept in — and priced at each material's cost now.
 *  `roundUpWhole` rounds whole-unit materials (pcs, sets…) up. */
export function consumptionFor(
  bom: Pick<Bom, "outputQty" | "components">,
  qty: number,
  itemsById: Map<string, Pick<Item, "purchasePrice" | "name" | "unit">>,
  roundUpWhole = false,
): ProductionLine[] {
  const scale = num(qty) / (num(bom.outputQty) || 1);
  return (bom.components ?? []).map((c) => {
    const item = itemsById.get(c.itemId);
    let total = num(c.qty) * scale * (1 + num(c.wastagePct) / 100);
    const unit = c.unit || item?.unit || "";
    total = roundUpWhole && isWholeUnit(unit) ? Math.ceil(total - 1e-9) : r2(total);
    const rate = r2(num(item?.purchasePrice));
    return {
      itemId: c.itemId,
      itemName: item?.name ?? c.itemName,
      unit,
      qty: total,
      rate,
      amount: r2(total * rate),
    };
  });
}

/** The BOM's labour/overhead, scaled from its output quantity to `qty`. */
export function scaledCosts(
  bom: Pick<Bom, "outputQty" | "additionalCosts">,
  qty: number,
): CostLine[] {
  const scale = num(qty) / (num(bom.outputQty) || 1);
  return (bom.additionalCosts ?? [])
    .filter((c) => num(c.amount) !== 0 || c.label.trim())
    .map((c) => ({ label: c.label, amount: r2(num(c.amount) * scale) }));
}

export interface ProductionTotals {
  materialCost: number;
  additionalCost: number;
  totalCost: number;
  unitCost: number;
}

export function productionTotals(
  components: Pick<ProductionLine, "amount">[],
  additionalCosts: CostLine[],
  qty: number,
): ProductionTotals {
  const materialCost = r2(components.reduce((s, c) => s + num(c.amount), 0));
  const additionalCost = r2(additionalCosts.reduce((s, c) => s + num(c.amount), 0));
  const totalCost = r2(materialCost + additionalCost);
  const unitCost = num(qty) > 0 ? r2(totalCost / num(qty)) : 0;
  return { materialCost, additionalCost, totalCost, unitCost };
}

/** What one finished unit costs by this BOM at today's material prices. */
export function bomUnitCost(
  bom: Pick<Bom, "outputQty" | "components" | "additionalCosts">,
  itemsById: Map<string, Pick<Item, "purchasePrice" | "name" | "unit">>,
): number {
  const out = num(bom.outputQty) || 1;
  const lines = consumptionFor(bom, out, itemsById);
  return productionTotals(lines, scaledCosts(bom, out), out).unitCost;
}

/**
 * Why a BOM cannot be saved as a recipe, or null.
 *
 * A finished item may be a material of ANOTHER BOM (a cushion made here and
 * used in a sofa) — but never of its own, directly or round a loop (sofa needs
 * cushion, cushion needs sofa). Such a recipe could never be made: each run
 * would need the other first.
 */
export function bomCycle(
  candidate: Pick<Bom, "id" | "finishedItemId" | "components">,
  allBoms: Pick<Bom, "id" | "finishedItemId" | "components" | "archived">[],
  nameOf: (itemId: string) => string,
): string | null {
  const target = candidate.finishedItemId;
  if (candidate.components.some((c) => c.itemId === target))
    return `"${nameOf(target)}" cannot be one of its own materials`;
  // Every live recipe except the one being edited, plus the candidate itself.
  const recipes = allBoms.filter((b) => b.id !== candidate.id && !b.archived).concat(candidate);
  const madeFrom = (itemId: string) =>
    recipes
      .filter((b) => b.finishedItemId === itemId)
      .flatMap((b) => b.components.map((c) => c.itemId));
  const seen = new Set<string>();
  const stack = candidate.components.map((c) => c.itemId);
  while (stack.length) {
    const id = stack.pop()!;
    if (id === target)
      return `"${nameOf(target)}" is needed, through another BOM, to make one of its own materials`;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...madeFrom(id));
  }
  return null;
}

/**
 * Items whose stock would go below zero, as messages.
 *
 * `apply` is what is about to be posted; `undo` what an edit or delete is
 * taking back first (its moves are reversed). Only an item whose stock FALLS
 * and ends negative is reported — an item that was already negative and is
 * not being drawn down further is not this save's doing.
 */
export function stockShortfalls(
  apply: StockMove[],
  undo: StockMove[],
  itemsById: Map<string, Pick<Item, "stock" | "name" | "unit">>,
): string[] {
  const net = new Map<string, number>();
  for (const m of apply) net.set(m.itemId, (net.get(m.itemId) ?? 0) + m.qty);
  for (const m of undo) net.set(m.itemId, (net.get(m.itemId) ?? 0) - m.qty);
  const out: string[] = [];
  for (const [id, delta] of net) {
    if (r2(delta) >= 0) continue;
    const item = itemsById.get(id);
    if (!item) continue;
    const after = r2(num(item.stock) + delta);
    if (after < 0)
      out.push(`${item.name}: ${r2(num(item.stock))} ${item.unit} in stock, needs ${r2(-delta)}`);
  }
  return out;
}

/** Latest production of an item, by date then entry time. */
export function latestProductionOf(itemId: string, all: Production[]): Production | undefined {
  return all
    .filter((p) => p.finishedItemId === itemId)
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
    )[0];
}

/**
 * The finished item's cost to restore when a run is deleted, or undefined to
 * leave it alone.
 *
 * Restored only while nothing has moved on: this run must still be the item's
 * latest production, and its cost must still be exactly what this run set.
 * A purchase, a later run or a hand edit since then is a newer and better
 * answer than putting back what was there before.
 */
export function costToRestore(
  p: Production,
  item: Pick<Item, "purchasePrice"> | undefined,
  all: Production[],
): number | undefined {
  if (!item || p.prevFinishedCost === undefined) return undefined;
  if (latestProductionOf(p.finishedItemId, all)?.id !== p.id) return undefined;
  if (Math.abs(num(item.purchasePrice) - num(p.unitCost)) > 0.005) return undefined;
  return p.prevFinishedCost;
}

/**
 * Labour and overhead the period's production runs moved INTO stock.
 *
 * The quick P&L takes cost of goods sold from each sale line's cost snapshot,
 * and a manufactured item's cost now includes its labour — while the wages
 * themselves are also booked as Expenses when paid. Without giving this back,
 * the same karigar wage would be deducted twice: once as an expense, again
 * inside the cost of every sofa sold. Subtracting it from expenses is the
 * standard "transferred to cost of production" line: labour on what was sold
 * is in COGS, labour on what is still in stock stays in stock.
 */
export function absorbedConversionCost(
  productions: Pick<Production, "date" | "additionalCost">[],
  from: string,
  to: string,
): number {
  return r2(
    productions
      .filter((p) => p.date >= from && p.date <= to)
      .reduce((s, p) => s + num(p.additionalCost), 0),
  );
}
