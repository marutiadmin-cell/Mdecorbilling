/**
 * Made to measure: from a size-based BOM and one measured window, the exact
 * materials it takes and what it costs and sells for — the shop's own costing
 * sheet, worked out by the app.
 *
 * The client's sheet for an Easy Lift wooden blind, W 58 × H 35 in:
 *
 *   BOTTOM        W_M          1.4732 m × 230   =   339
 *   SLATES        31          ×  54             = 1,674
 *   HEAD RAIL     W_FT         4.8333 ft × 112  =   542
 *   …                                               …
 *   LABOUR                                          350
 *   TOTAL                                         4,087
 *   SQ.FT         58 × 35 / 144                   14.10
 *   Net sq.ft price  4,087 / 14.10               289.92
 *   + MAINTENANCE 47                             336.92
 *   MIN SALE  × 1.10                             370.61
 *   MAX SALE  × 1.54                             518.85
 *
 * Pure: items and their rates come in as arguments, so the BOM screen, the
 * measure dialog on a bill, a job card and the tests all compute the same.
 */
import type { Bom, BomComponent, CostLine, Item, ProductionLine } from "@/types";
import { evaluate, sizeVars, FormulaError, type MeasuredSize } from "@/lib/formula";
import { toItemUnit, lengthUnitOf } from "@/lib/units";
import { isWholeUnit } from "@/lib/production";

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export interface SizeProblem {
  /** Which row: "material 3" / "labour 1" / an input name. */
  where: string;
  /** Index into components / additionalCosts, for the screen to highlight. */
  index: number;
  kind: "material" | "cost";
  message: string;
  pos: number;
}

export interface ResolvedComponent extends BomComponent {
  /** For ONE piece, in the item's own unit, wastage included. */
  qty: number;
  /** What the formula answered, before unit conversion and wastage. */
  formulaValue?: number;
  /** A length answer landed on an item not stocked in a length (or vice
   *  versa) — almost always a mistake in the BOM. */
  unitMismatch?: boolean;
}

/** The variables one window gives every formula of this BOM. */
export function bomVars(
  bom: Pick<Bom, "sizing">,
  size: MeasuredSize,
  constants: { key: string; value: number }[] = [],
  inputs: Record<string, number> = {},
  pieces = 1,
): Record<string, number> {
  const extra: Record<string, number> = {};
  for (const c of constants) if (c.key) extra[c.key.toUpperCase()] = Number(c.value) || 0;
  for (const i of bom.sizing?.inputs ?? [])
    if (i.key) extra[i.key.toUpperCase()] = Number(i.default) || 0;
  for (const [k, v] of Object.entries(inputs)) extra[k.toUpperCase()] = Number(v) || 0;
  return sizeVars(size, bom.sizing?.formulaUnit ?? size.unit, extra, pieces);
}

/**
 * The materials ONE piece of this size takes. A fixed BOM resolves to its
 * own quantities per finished unit, so every caller can use this for both.
 */
export function resolveComponents(
  bom: Pick<Bom, "sizing" | "components" | "outputQty">,
  vars: Record<string, number>,
  itemsById: Map<string, Pick<Item, "unit">>,
): { components: ResolvedComponent[]; problems: SizeProblem[] } {
  const problems: SizeProblem[] = [];
  const out: ResolvedComponent[] = [];
  bom.components.forEach((c, index) => {
    const item = itemsById.get(c.itemId);
    const itemUnit = item?.unit || c.unit;
    let base = Number(c.qty) || 0;
    let formulaValue: number | undefined;
    let unitMismatch = false;
    if (bom.sizing && c.qtyFormula?.trim()) {
      try {
        formulaValue = evaluate(c.qtyFormula, vars);
        const conv = toItemUnit(formulaValue, c.resultUnit, itemUnit);
        base = conv.value;
        unitMismatch = conv.mismatch;
      } catch (e) {
        problems.push({
          where: `${c.itemName || "material"} (row ${index + 1})`,
          index,
          kind: "material",
          message: e instanceof FormulaError ? e.message : String(e),
          pos: e instanceof FormulaError ? e.pos : 0,
        });
        base = 0;
      }
    } else if (!bom.sizing) {
      base = base / (Number(bom.outputQty) || 1);
    }
    if (base < 0) {
      problems.push({
        where: `${c.itemName || "material"} (row ${index + 1})`,
        index,
        kind: "material",
        message: `works out below zero (${r4(base)}) for this size`,
        pos: 0,
      });
      base = 0;
    }
    const qty = r4(base * (1 + (Number(c.wastagePct) || 0) / 100));
    out.push({ ...c, unit: itemUnit, qty, formulaValue, unitMismatch });
  });
  return { components: out, problems };
}

/** Labour / overhead for ONE piece of this size. */
export function resolveCosts(
  bom: Pick<Bom, "sizing" | "additionalCosts" | "outputQty">,
  vars: Record<string, number>,
): { costs: CostLine[]; problems: SizeProblem[] } {
  const problems: SizeProblem[] = [];
  const costs = (bom.additionalCosts ?? []).map((c, index) => {
    let amount = Number(c.amount) || 0;
    if (bom.sizing && c.formula?.trim()) {
      try {
        amount = evaluate(c.formula, vars);
      } catch (e) {
        problems.push({
          where: `${c.label || "cost"} (row ${index + 1})`,
          index,
          kind: "cost",
          message: e instanceof FormulaError ? e.message : String(e),
          pos: e instanceof FormulaError ? e.pos : 0,
        });
        amount = 0;
      }
    } else if (!bom.sizing) {
      amount = amount / (Number(bom.outputQty) || 1);
    }
    return { label: c.label, amount: r2(amount) };
  });
  return { costs, problems };
}

export interface CostSheetLine {
  itemId: string;
  name: string;
  unit: string;
  qty: number;
  rate: number;
  amount: number;
  unitMismatch?: boolean;
}

export interface CostSheet {
  lines: CostSheetLine[];
  costs: CostLine[];
  materialTotal: number;
  additionalTotal: number;
  /** Cost of ONE piece. */
  total: number;
  /** Area of one piece, and the area charged for it (never below minimum). */
  sqft: number;
  chargeableSqft: number;
  basis: "sqft" | "piece";
  /** Per sq ft when basis is sqft, else per piece. */
  costPerUnit: number;
  withAddOn: number;
  minRate: number;
  maxRate: number;
  /** The same rates for one whole piece (rate × chargeable sq ft). */
  minPerPiece: number;
  maxPerPiece: number;
  problems: SizeProblem[];
}

const roundLine = (n: number, how: "none" | "nearest" | "up" | undefined) =>
  how === "up" ? Math.ceil(n - 1e-6) : how === "nearest" ? Math.round(n) : r2(n);

/**
 * The full costing sheet for ONE piece of this size.
 *
 * `rateOf` is the item's cost per its own unit — the app passes its weighted
 * average cost (lib/finData.ts costOf), falling back to the purchase price.
 */
export function costSheet(
  bom: Bom,
  size: MeasuredSize,
  itemsById: Map<string, Item>,
  rateOf: (item: Item) => number,
  opts: {
    constants?: { key: string; value: number }[];
    inputs?: Record<string, number>;
    /** Settings → Manufacturing minimum, when the BOM sets none. */
    minSqft?: number;
  } = {},
): CostSheet {
  const vars = bomVars(bom, size, opts.constants, opts.inputs, 1);
  const { components, problems } = resolveComponents(bom, vars, itemsById);
  const { costs, problems: costProblems } = resolveCosts(bom, vars);
  const pricing = bom.sizing?.pricing;
  const how = pricing?.roundLines ?? "none";

  const lines: CostSheetLine[] = components.map((c) => {
    const item = itemsById.get(c.itemId);
    const rate = item ? r2(rateOf(item)) : 0;
    return {
      itemId: c.itemId,
      name: item?.name ?? c.itemName,
      unit: c.unit,
      qty: c.qty,
      rate,
      amount: roundLine(c.qty * rate, how),
      unitMismatch: c.unitMismatch,
    };
  });
  const roundedCosts = costs.map((c) => ({ ...c, amount: roundLine(c.amount, how) }));
  const materialTotal = r2(lines.reduce((s, l) => s + l.amount, 0));
  const additionalTotal = r2(roundedCosts.reduce((s, c) => s + c.amount, 0));
  const total = r2(materialTotal + additionalTotal);

  const sqft = vars.SQFT;
  const minSqft = pricing?.minSqft ?? opts.minSqft ?? 0;
  const chargeableSqft = Math.max(sqft, minSqft);
  const basis = pricing?.basis ?? "sqft";
  // Cost per sq ft is over the REAL area (what it took to make), exactly as
  // the sheet does; the minimum area only changes what is charged.
  const costPerUnit = basis === "sqft" ? (sqft > 0 ? total / sqft : 0) : total;
  const withAddOn = costPerUnit + (Number(pricing?.addPerUnit) || 0);
  const minRate = withAddOn * (1 + (Number(pricing?.minMarginPct) || 0) / 100);
  const maxRate = withAddOn * (1 + (Number(pricing?.maxMarginPct) || 0) / 100);
  const perPiece = (rate: number) => (basis === "sqft" ? rate * chargeableSqft : rate);

  return {
    lines,
    costs: roundedCosts,
    materialTotal,
    additionalTotal,
    total,
    sqft: r4(sqft),
    chargeableSqft: r4(chargeableSqft),
    basis,
    costPerUnit: r4(costPerUnit),
    withAddOn: r4(withAddOn),
    minRate: r4(minRate),
    maxRate: r4(maxRate),
    minPerPiece: r2(perPiece(minRate)),
    maxPerPiece: r2(perPiece(maxRate)),
    problems: [...problems, ...costProblems],
  };
}

/** Is this item unit a length — i.e. can a length formula land on it? */
export const isLengthUnit = (unit?: string) => !!lengthUnitOf(unit);

/**
 * What a production run of `pieces` blinds of this size consumes — the same
 * shape `consumptionFor` gives a fixed BOM, so the production screen and its
 * save path do not care which kind of BOM it was.
 *
 * Whole-unit materials (pcs, sets) round up per RUN, not per piece: three
 * blinds needing 2.4 brackets each take 8, not 9.
 */
export function consumptionForSize(
  bom: Bom,
  size: MeasuredSize,
  pieces: number,
  itemsById: Map<string, Pick<Item, "purchasePrice" | "name" | "unit">>,
  opts: {
    constants?: { key: string; value: number }[];
    inputs?: Record<string, number>;
    roundUpWhole?: boolean;
  } = {},
): { lines: ProductionLine[]; costs: CostLine[]; problems: SizeProblem[] } {
  const n = Number(pieces) || 0;
  const vars = bomVars(bom, size, opts.constants, opts.inputs, n);
  const { components, problems } = resolveComponents(bom, vars, itemsById);
  const { costs, problems: costProblems } = resolveCosts(bom, vars);
  const lines = components.map((c) => {
    const item = itemsById.get(c.itemId);
    let total = c.qty * n;
    total = opts.roundUpWhole && isWholeUnit(c.unit) ? Math.ceil(total - 1e-9) : r2(total);
    const rate = r2(Number(item?.purchasePrice) || 0);
    return {
      itemId: c.itemId,
      itemName: item?.name ?? c.itemName,
      unit: c.unit,
      qty: total,
      rate,
      amount: r2(total * rate),
    };
  });
  return {
    lines,
    costs: costs.map((c) => ({ label: c.label, amount: r2(c.amount * n) })),
    problems: [...problems, ...costProblems],
  };
}

/**
 * How many finished units a made-to-measure run is: area charged × pieces
 * when the finished item is stocked by area (a blind sold by the sq ft),
 * otherwise the pieces themselves.
 */
export function madeQty(
  bom: Bom,
  size: MeasuredSize,
  pieces: number,
  finishedUnit: string | undefined,
  minSqftSetting?: number,
): number {
  const n = Number(pieces) || 0;
  const u = (finishedUnit || "").trim().toLowerCase().replace(/[\s.]/g, "");
  if (u === "sqft" || u === "sft") {
    const sqft = bomVars(bom, size).SQFT;
    const min = bom.sizing?.pricing?.minSqft ?? minSqftSetting ?? 0;
    return r2(Math.max(sqft, min) * n);
  }
  if (u === "sqm") return r2(bomVars(bom, size).SQM * n);
  return n;
}

/** A blind's size as it is written on a job card or a bill line. */
export function sizeLabel(size: { w: number; h: number; unit: string }): string {
  const u = size.unit === "in" ? '"' : ` ${size.unit}`;
  const f = (n: number) => String(Math.round((Number(n) || 0) * 100) / 100);
  return `W ${f(size.w)}${u} × H ${f(size.h)}${u}`;
}
