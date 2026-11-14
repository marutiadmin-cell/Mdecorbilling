/**
 * Made-to-measure audit — run from audit.test.ts.
 *
 *  1. The formula language: precedence, functions, units, and that a bad
 *     formula says WHERE it is wrong instead of answering nonsense.
 *  2. The client's own costing sheet (Easy Lift wooden blind, W 58 × H 35 in)
 *     reproduced to the rupee: ₹4,087 · 14.10 sq ft · ₹289.92 · ₹370.61 ·
 *     ₹518.85. If this drifts, the app no longer agrees with the shop's Excel.
 *  3. The same blind measured in cm and mm costs the same.
 *  4. A fixed (non-size) BOM resolves to exactly what it always did.
 */
import type { Bom, Item } from "@/types";
import { evaluate, tryEvaluate, syntaxError, sizeVars } from "@/lib/formula";
import { convertLength, lengthUnitOf, toItemUnit } from "@/lib/units";
import { costSheet, resolveComponents, bomVars } from "@/lib/sizing";

type Assert = (cond: boolean, msg: string) => void;
const close = (a: number, b: number, eps = 0.005) => Math.abs(a - b) < eps;

function formulaLanguage(assert: Assert) {
  const v = { W: 58, H: 35, PITCH: 1.13 };
  assert(evaluate("2 + 3 * 4", v) === 14, "SZ1: * before +");
  assert(evaluate("(2 + 3) * 4", v) === 20, "SZ1: brackets");
  assert(evaluate("2 ^ 3 ^ 2", v) === 512, "SZ1: ^ is right-associative");
  assert(evaluate("-W + 60", v) === 2, "SZ1: unary minus");
  assert(evaluate("ceil(h / pitch)", v) === 31, "SZ1: names and functions are case-insensitive");
  assert(evaluate("CEIL(W / 24)", v) === 3, "SZ1: ladders for 58 in = 3");
  assert(evaluate("CEIL(7.01, 0.5)", v) === 7.5, "SZ1: CEIL to a step");
  assert(evaluate("CEIL(6, 1)", v) === 6, "SZ1: CEIL of a whole number stays put");
  assert(evaluate("ROUND(2.345, 2)", v) === 2.35, "SZ1: ROUND to decimals");
  assert(evaluate("IF(W > 48, 3, 2)", v) === 3, "SZ1: IF with a comparison");
  assert(
    evaluate("IF(W > 0, H / W, 1 / 0)", v) === 35 / 58,
    "SZ1: IF only works out the branch it takes",
  );
  assert(evaluate("MAX(1, W / 100, 0.2)", v) === 1, "SZ1: MAX of several");
  assert(evaluate("58 × 35 ÷ 144", v) === (58 * 35) / 144, "SZ1: × and ÷ from a phone keyboard");
  assert(evaluate("2", v) === 2, "SZ1: a bare number is a fixed quantity");

  const bad = tryEvaluate("W * HIEGHT", v);
  assert(
    !!bad.error && bad.pos === 4,
    `SZ2: a misspelt name is pointed at (pos ${bad.pos}): ${bad.error}`,
  );
  const unclosed = syntaxError("CEIL(W / 24");
  assert(
    !!unclosed && unclosed.pos === 4,
    `SZ2: an unclosed bracket is pointed at (${JSON.stringify(unclosed)})`,
  );
  assert(!!tryEvaluate("W / (H - 35)", v).error, "SZ2: dividing by zero is an error, not Infinity");
  assert(!!syntaxError("W ** 2"), "SZ2: ** is not silently accepted");
  assert(!!syntaxError("alert(1); W"), "SZ2: nothing but arithmetic can run");
  assert(!!syntaxError(""), "SZ2: an empty formula is an error");
  assert(!!tryEvaluate("FOO(W)", v).error, "SZ2: unknown functions are refused");

  assert(close(convertLength(58, "in", "m"), 1.4732), "SZ3: 58 in = 1.4732 m");
  assert(close(convertLength(58, "in", "ft"), 4.83333), "SZ3: 58 in = 4.8333 ft");
  assert(close(convertLength(147.32, "cm", "in"), 58), "SZ3: cm → in");
  assert(
    lengthUnitOf("Mtr") === "m" && lengthUnitOf("RFT") === "ft" && lengthUnitOf("pcs") === null,
    "SZ3: unit spellings",
  );
  assert(
    close(toItemUnit(4.8333, "ft", "in").value, 58, 0.01),
    "SZ3: a feet answer lands on an inch item",
  );
  assert(toItemUnit(3, "pcs", "pcs").value === 3, "SZ3: a count is not converted");
  assert(toItemUnit(1.47, "m", "pcs").mismatch, "SZ3: a length answer on a pcs item is flagged");

  const sv = sizeVars({ w: 147.32, h: 88.9, unit: "cm" }, "in");
  assert(
    close(sv.W, 58) && close(sv.H, 35) && close(sv.W_FT, 4.83333),
    "SZ4: cm size gives inch W/H",
  );
  assert(close(sv.SQFT, 14.09722), `SZ4: area 14.0972 sq ft, got ${sv.SQFT}`);
}

/* ── The client's sheet ─────────────────────────────────────────────── */
const ITEM = (id: string, name: string, unit: string, price: number): Item =>
  ({
    id,
    name,
    unit,
    purchasePrice: price,
    salePrice: 0,
    gstRate: 0,
    stock: 0,
    openingStock: 0,
    createdAt: "",
  }) as Item;
const ITEMS = [
  ITEM("BOT", "Bottom rail", "m", 230),
  ITEM("SLT", "Slat 50mm", "pcs", 54),
  ITEM("HR", "Head rail", "ft", 112),
  ITEM("MEC", "Mechanism", "pcs", 218),
  ITEM("ATR", "ATR", "pcs", 140),
  ITEM("CHN", "Chain", "pcs", 50),
  ITEM("LT", "Ladder tape", "pcs", 30),
  ITEM("ROD", "Rod", "ft", 18),
  ITEM("CB", "Ceiling bracket", "pcs", 30),
  ITEM("DOR", "Dori (andar ni)", "pcs", 3),
  ITEM("BL", "Bottom lock", "pcs", 10),
  ITEM("BLIND", "Wooden Blind Easy Lift", "sqft", 0),
];
const comp = (itemId: string, qtyFormula: string, resultUnit?: string) => {
  const it = ITEMS.find((i) => i.id === itemId)!;
  return { itemId, itemName: it.name, unit: it.unit, qty: 0, qtyFormula, resultUnit };
};
export const EASY_LIFT: Bom = {
  id: "B-EASY",
  name: "Wooden Blind — Easy Lift",
  finishedItemId: "BLIND",
  finishedItemName: "Wooden Blind Easy Lift",
  outputQty: 1,
  components: [
    comp("BOT", "W", "in"), // the bottom rail is as long as the blind is wide
    comp("SLT", "CEIL(H / SLAT_PITCH)"),
    comp("HR", "W", "in"),
    comp("MEC", "2"),
    comp("ATR", "LADDERS"),
    comp("CHN", "1"),
    comp("LT", "LADDERS"),
    comp("ROD", "W", "in"),
    comp("CB", "2"),
    comp("DOR", "LADDERS"),
    comp("BL", "LADDERS"),
  ],
  additionalCosts: [{ label: "Labour", amount: 350 }],
  sizing: {
    formulaUnit: "in",
    inputs: [{ key: "LADDERS", label: "Ladders", default: 3 }],
    pricing: {
      basis: "sqft",
      addPerUnit: 47,
      minMarginPct: 10,
      maxMarginPct: 54,
      roundLines: "up",
    },
  },
  createdAt: "",
};
const CONSTANTS = [{ key: "SLAT_PITCH", value: 1.13 }];

function clientSheet(assert: Assert) {
  const byId = new Map(ITEMS.map((i) => [i.id, i] as const));
  const rate = (i: Item) => i.purchasePrice;
  const sheet = costSheet(EASY_LIFT, { w: 58, h: 35, unit: "in" }, byId, rate, {
    constants: CONSTANTS,
  });
  assert(
    sheet.problems.length === 0,
    `SZ5: the sheet has no formula problems: ${JSON.stringify(sheet.problems)}`,
  );
  const line = (id: string) => sheet.lines.find((l) => l.itemId === id)!;
  assert(close(line("BOT").qty, 1.4732), `SZ5: bottom rail 1.4732 m, got ${line("BOT").qty}`);
  assert(line("BOT").amount === 339, `SZ5: bottom rail ₹339, got ${line("BOT").amount}`);
  assert(
    line("SLT").qty === 31 && line("SLT").amount === 1674,
    `SZ5: 31 slats ₹1,674, got ${line("SLT").qty} ₹${line("SLT").amount}`,
  );
  assert(close(line("HR").qty, 4.8333, 0.001), `SZ5: head rail 4.8333 ft, got ${line("HR").qty}`);
  assert(line("HR").amount === 542, `SZ5: head rail ₹542, got ${line("HR").amount}`);
  assert(line("ROD").amount === 87, `SZ5: rod ₹87, got ${line("ROD").amount}`);
  assert(
    line("ATR").amount === 420 && line("DOR").amount === 9,
    "SZ5: per-ladder items follow LADDERS",
  );
  assert(sheet.total === 4087, `SZ5: TOTAL ₹4,087, got ${sheet.total}`);
  assert(close(sheet.sqft, 14.0972, 0.0001), `SZ5: SQ.FT 14.0972, got ${sheet.sqft}`);
  assert(
    close(sheet.costPerUnit, 289.9153, 0.001),
    `SZ5: net sq.ft price 289.9153, got ${sheet.costPerUnit}`,
  );
  assert(
    close(sheet.withAddOn, 336.9153, 0.001),
    `SZ5: + maintenance 336.9153, got ${sheet.withAddOn}`,
  );
  assert(close(sheet.minRate, 370.6068, 0.001), `SZ5: minimum sale 370.6068, got ${sheet.minRate}`);
  assert(close(sheet.maxRate, 518.8495, 0.001), `SZ5: maximum sale 518.8495, got ${sheet.maxRate}`);

  // The same window measured in cm costs the same.
  const cm = costSheet(EASY_LIFT, { w: 147.32, h: 88.9, unit: "cm" }, byId, rate, {
    constants: CONSTANTS,
  });
  assert(
    cm.total === 4087 && close(cm.maxRate, sheet.maxRate, 0.001),
    `SZ6: measured in cm, same ₹${cm.total}`,
  );
  const mm = costSheet(EASY_LIFT, { w: 1473.2, h: 889, unit: "mm" }, byId, rate, {
    constants: CONSTANTS,
  });
  assert(mm.total === 4087, `SZ6: measured in mm, same ₹${mm.total}`);

  // A minimum chargeable area changes the charge, never the cost rate.
  const small = costSheet(EASY_LIFT, { w: 24, h: 30, unit: "in" }, byId, rate, {
    constants: CONSTANTS,
    minSqft: 15,
  });
  assert(
    close(small.sqft, 5) && small.chargeableSqft === 15,
    `SZ7: 5 sq ft blind charged as 15, got ${small.chargeableSqft}`,
  );
  assert(
    close(small.maxPerPiece, small.maxRate * 15, 0.01),
    "SZ7: per-piece price uses the chargeable area",
  );

  // An input given on the order overrides the BOM default.
  const wide = costSheet(EASY_LIFT, { w: 58, h: 35, unit: "in" }, byId, rate, {
    constants: CONSTANTS,
    inputs: { LADDERS: 4 },
  });
  assert(
    wide.lines.find((l) => l.itemId === "ATR")!.qty === 4,
    "SZ8: an order's LADDERS = 4 overrides the default 3",
  );

  // A broken formula is reported against its row and costs nothing, rather
  // than throwing the whole screen away.
  const broken: Bom = {
    ...EASY_LIFT,
    components: [comp("SLT", "CEIL(H / SLATPITCH)"), ...EASY_LIFT.components.slice(2)],
  };
  const b = costSheet(broken, { w: 58, h: 35, unit: "in" }, byId, rate, { constants: CONSTANTS });
  assert(
    b.problems.length === 1 && b.problems[0].index === 0,
    `SZ9: the bad row is named: ${JSON.stringify(b.problems)}`,
  );
}

function fixedBomUnchanged(assert: Assert) {
  // A sofa BOM with no sizing: per-unit quantities are qty / outputQty, as
  // production always computed them.
  const sofa: Bom = {
    id: "S",
    name: "Sofa",
    finishedItemId: "X",
    finishedItemName: "Sofa",
    outputQty: 2,
    components: [{ itemId: "F", itemName: "Fabric", unit: "m", qty: 24, wastagePct: 5 }],
    additionalCosts: [{ label: "Labour", amount: 6000 }],
    createdAt: "",
  };
  const vars = bomVars(sofa, { w: 0, h: 0, unit: "in" });
  const r = resolveComponents(sofa, vars, new Map([["F", { unit: "m" }]]));
  assert(
    close(r.components[0].qty, 12.6),
    `SZ10: fixed BOM gives 24/2 × 1.05 = 12.6 per sofa, got ${r.components[0].qty}`,
  );
}

export function runSizingAudit(assert: Assert) {
  formulaLanguage(assert);
  clientSheet(assert);
  fixedBomUnchanged(assert);
}
