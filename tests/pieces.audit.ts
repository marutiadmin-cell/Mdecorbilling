/**
 * By-length stock audit (slats, rails, rods) — run from audit.test.ts.
 *
 *  1. Cutting picks the right piece: the longest cuts first, each from the
 *     SMALLEST piece it fits (offcuts before full bars), reusing a piece
 *     already opened in the job; saw width charged; leftovers at least the
 *     minimum kept, shorter ones scrap; unsorted length used last.
 *  2. Nothing is ever lost or invented: for random stock and random jobs,
 *     taken + from-unsorted = used + scrap + returned, to the 1/10,000.
 *  3. Sizes are derived from documents: sorts, piece adjustments and
 *     production cuts, with a run excluded when it is being re-planned.
 *  4. A BOM row cut as pieces resolves to count × length in the item's unit.
 */
import type { Bom, Item, PieceSort, Production, StockAdjustment } from "@/types";
import { planCuts, piecesLength } from "@/lib/cutting";
import { allBags, sizeBreaksIf } from "@/lib/pieces";
import { bomVars, resolveComponents } from "@/lib/sizing";

type Assert = (cond: boolean, msg: string) => void;
const close = (a: number, b: number, eps = 0.0002) => Math.abs(a - b) < eps;
const conserved = (p: ReturnType<typeof planCuts>) =>
  // used and scrap are posted to 2 decimals, as stock is kept.
  close(piecesLength(p.taken) + p.fromLoose, p.used + p.scrap + piecesLength(p.returned), 0.0051);

function cutting(assert: Assert) {
  // Six slats of 58" (4.8333 ft) from 20 ft × 2 and 10 ft × 1, keep ≥ 1 ft.
  const L = 58 / 12;
  const a = planCuts(
    Array(6).fill(L),
    [
      { length: 20, count: 2 },
      { length: 10, count: 1 },
    ],
    { minOffcut: 1 },
  );
  assert(
    JSON.stringify(a.taken) ===
      JSON.stringify([
        { length: 20, count: 1 },
        { length: 10, count: 1 },
      ]),
    `PC1: the 10 ft piece is used before a second 20 ft one — took ${JSON.stringify(a.taken)}`,
  );
  assert(
    a.returned.length === 0 && close(a.scrap, 30 - 6 * L, 0.006),
    `PC1: both ends under 1 ft are scrap (${a.scrap})`,
  );
  assert(close(a.used, 6 * L, 0.006) && conserved(a), "PC1: used = 6 cuts; nothing lost");

  const b = planCuts(
    Array(6).fill(L),
    [
      { length: 20, count: 2 },
      { length: 10, count: 1 },
    ],
    { minOffcut: 0.5 },
  );
  assert(
    b.returned.length === 1 && close(b.returned[0].length, 20 - 4 * L, 0.001),
    `PC2: a 0.67 ft end is kept when the minimum is 0.5 — ${JSON.stringify(b.returned)}`,
  );
  assert(conserved(b), "PC2: nothing lost");

  const c = planCuts(
    [5],
    [
      { length: 20, count: 5 },
      { length: 6, count: 1 },
    ],
    { minOffcut: 1 },
  );
  assert(
    c.taken[0].length === 6 && c.returned[0]?.length === 1,
    `PC3: an offcut that fits is used before a full bar — ${JSON.stringify(c)}`,
  );

  const d = planCuts([4, 4], [{ length: 10, count: 1 }], { kerf: 0.1, minOffcut: 1 });
  assert(
    close(d.used, 8.2) && d.returned[0]?.length === 1.8,
    `PC4: the saw takes 0.1 per cut — used ${d.used}, kept ${JSON.stringify(d.returned)}`,
  );

  const e = planCuts([4], [], { loose: 10 });
  assert(
    e.fromLoose === 4 && e.taken.length === 0 && e.scrap === 0 && e.short === 0,
    "PC5: unsorted length is cut when no size fits",
  );
  const f = planCuts([4], [], { loose: 2 });
  assert(f.short === 2, `PC6: not enough anywhere is reported as short by 2, got ${f.short}`);
  const g = planCuts([12], [{ length: 10, count: 3 }], { loose: 0 });
  assert(
    g.taken.length === 0 && g.short === 12,
    "PC7: a cut longer than every piece is not cut from two pieces",
  );

  // Randomized conservation.
  let seed = 4242;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let bad = 0;
  for (let i = 0; i < 400 && bad < 3; i++) {
    const stock = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({
      length: Math.round((2 + rnd() * 18) * 100) / 100,
      count: Math.floor(rnd() * 6),
    }));
    const cuts = Array.from(
      { length: Math.floor(rnd() * 30) },
      () => Math.round((0.5 + rnd() * 9) * 100) / 100,
    );
    const p = planCuts(cuts, stock, {
      minOffcut: rnd() * 2,
      kerf: rnd() < 0.3 ? 0.02 : 0,
      loose: rnd() * 40,
    });
    if (!conserved(p)) {
      bad++;
      assert(false, `PC8: length lost or invented — ${JSON.stringify({ stock, cuts, p })}`);
    }
    const takenCount = p.taken.reduce((s, t) => s + t.count, 0);
    const available = stock.reduce((s, t) => s + t.count, 0);
    if (takenCount > available) {
      bad++;
      assert(false, `PC8: took ${takenCount} pieces from ${available}`);
    }
  }
  if (!bad) assert(true, "PC8: 400 random jobs — nothing lost, never more pieces than there are");
}

function sizes(assert: Assert) {
  const slat = { id: "S", stock: 100, openingStock: 100, pieces: { minOffcut: 1 } } as Item;
  const sort: PieceSort = {
    id: "PS1",
    itemId: "S",
    itemName: "Slat",
    date: "2026-01-01",
    pieces: [{ length: 20, count: 4 }],
    createdAt: "",
  };
  const add: StockAdjustment = {
    id: "A1",
    itemId: "S",
    itemName: "Slat",
    date: "2026-01-02",
    type: "add",
    qty: 10,
    pieces: [{ length: 5, count: 2 }],
    createdAt: "",
  };
  const run = {
    id: "MF1",
    date: "2026-01-03",
    cuts: [
      {
        itemId: "S",
        cuts: [],
        taken: [{ length: 20, count: 1 }],
        returned: [{ length: 3, count: 1 }],
        scrap: 0.5,
        fromLoose: 0,
      },
    ],
  } as unknown as Production;
  const b = allBags([slat], {
    stockAdjustments: [add],
    pieceSorts: [sort],
    productions: [run],
  }).get("S")!;
  assert(
    JSON.stringify(b.pieces) ===
      JSON.stringify([
        { length: 20, count: 3 },
        { length: 5, count: 2 },
        { length: 3, count: 1 },
      ]),
    `PS1: sorts + added pieces − cut + kept offcut — ${JSON.stringify(b.pieces)}`,
  );
  // Replayed: 100 opening − 80 sorted = 20 unsorted; the added pieces and
  // the run both named their pieces, so unsorted stays 20.
  assert(close(b.loose, 20), `PS1: unsorted replayed from the documents, got ${b.loose}`);
  const without = allBags(
    [slat],
    { stockAdjustments: [add], pieceSorts: [sort], productions: [run] },
    { excludeProductionId: "MF1" },
  ).get("S")!;
  assert(without.pieces[0].count === 4, "PS2: re-planning a run puts its own pieces back");
  const plain = allBags([{ id: "X", stock: 5 } as Item], {
    stockAdjustments: [],
    pieceSorts: [],
    productions: [],
  });
  assert(!plain.has("X"), "PS3: an ordinary item has no sizes");
}

function bomCut(assert: Assert) {
  const items = new Map([
    ["SL", { unit: "FT" }],
    ["HR", { unit: "FT" }],
  ]);
  const bom = {
    outputQty: 1,
    sizing: { formulaUnit: "in" },
    components: [
      {
        itemId: "SL",
        itemName: "Slat",
        unit: "FT",
        qty: 0,
        cut: { countFormula: "CEIL(H / 1.13)", lengthFormula: "W" },
      },
      {
        itemId: "HR",
        itemName: "Head rail",
        unit: "FT",
        qty: 0,
        cut: { countFormula: "1", lengthFormula: "W - 0.5" },
      },
    ],
  } as unknown as Bom;
  const r = resolveComponents(bom, bomVars(bom, { w: 58, h: 35, unit: "in" }), items);
  const slat = r.components[0];
  assert(
    slat.cutCount === 31 && close(slat.cutLength!, 58 / 12),
    `PB1: 31 slats of 4.8333 ft — ${slat.cutCount} × ${slat.cutLength}`,
  );
  assert(close(slat.qty, 31 * (58 / 12), 0.001), "PB1: quantity = count × length");
  assert(
    close(r.components[1].cutLength!, 57.5 / 12),
    "PB2: a deduction in the length formula applies",
  );
  const cm = resolveComponents(bom, bomVars(bom, { w: 147.32, h: 88.9, unit: "cm" }), items);
  assert(
    cm.components[0].cutCount === 31 && close(cm.components[0].cutLength!, 58 / 12, 0.001),
    "PB3: the same blind measured in cm cuts the same",
  );
}

export function runPiecesAudit(assert: Assert) {
  cutting(assert);
  sizes(assert);
  bomCut(assert);
}

/* Movements that name no pieces: unsorted first, then the pieces. */
export function runReplayAudit(assert: Assert) {
  const it = { id: "R", stock: 0, openingStock: 10, pieces: { minOffcut: 1 } } as Item;
  const sort: PieceSort = {
    id: "s",
    itemId: "R",
    itemName: "R",
    date: "2026-01-01",
    pieces: [{ length: 20, count: 2 }],
    createdAt: "",
  };
  const purchase = { id: "p", date: "2026-01-02", lineItems: [{ itemId: "R", qty: 40 }] } as never;
  const sale = (d: string, q: number) =>
    ({ id: d, date: d, lineItems: [{ itemId: "R", qty: q }] }) as never;
  const data = (sales: never[]) => ({
    stockAdjustments: [],
    pieceSorts: [sort],
    productions: [],
    purchases: [purchase],
    sales,
  });
  // opening 10 → sort 40 (needs 40, only 10 unsorted → unsorted −30) → buy 40 → unsorted 10
  const b0 = allBags([it], data([])).get("R")!;
  assert(
    close(b0.loose, 10) && b0.pieces[0]?.count === 2,
    `PR1: 10 opening − 40 sorted + 40 bought = 10 unsorted — ${JSON.stringify(b0)}`,
  );
  // sell 15: 10 from unsorted, 5 cut from a 20 ft piece → 15 ft piece remains
  const b1 = allBags([it], data([sale("2026-01-03", 15)])).get("R")!;
  assert(
    close(b1.loose, 0) &&
      JSON.stringify(b1.pieces) ===
        JSON.stringify([
          { length: 20, count: 1 },
          { length: 15, count: 1 },
        ]),
    `PR2: a sale takes unsorted first, then cuts the rest from a piece — ${JSON.stringify(b1)}`,
  );
  // sell 30 more: no single piece is 30 → the 20 whole, then 10 cut from the 15 → 5 left
  const b2 = allBags([it], data([sale("2026-01-03", 15), sale("2026-01-04", 30)])).get("R")!;
  assert(
    close(b2.loose, 0) && JSON.stringify(b2.pieces) === JSON.stringify([{ length: 5, count: 1 }]),
    `PR3: longer than any piece → whole pieces, then a cut — ${JSON.stringify(b2)}`,
  );
  assert(close(b2.sized + b2.loose, 10 + 40 - 45), "PR3: sizes + unsorted = what is left (5)");
}

/* Deleting a run whose offcut a later run cut again would break the sizes. */
export function runGuardAudit(assert: Assert) {
  const it = {
    id: "G",
    name: "Slat",
    unit: "FT",
    stock: 0,
    openingStock: 0,
    pieces: { minOffcut: 1 },
  } as Item;
  const sort: PieceSort = {
    id: "s",
    itemId: "G",
    itemName: "Slat",
    date: "2026-01-01",
    pieces: [{ length: 20, count: 1 }],
    createdAt: "",
  };
  const add: StockAdjustment = {
    id: "a",
    itemId: "G",
    itemName: "Slat",
    date: "2026-01-01",
    type: "add",
    qty: 20,
    createdAt: "",
  };
  const runA = {
    id: "A",
    date: "2026-01-02",
    components: [],
    cuts: [
      {
        itemId: "G",
        cuts: [],
        taken: [{ length: 20, count: 1 }],
        returned: [{ length: 5, count: 1 }],
        scrap: 0,
        fromLoose: 0,
      },
    ],
  } as unknown as Production;
  const runB = {
    id: "B",
    date: "2026-01-03",
    components: [],
    cuts: [
      {
        itemId: "G",
        cuts: [],
        taken: [{ length: 5, count: 1 }],
        returned: [],
        scrap: 0,
        fromLoose: 0,
      },
    ],
  } as unknown as Production;
  const data = { stockAdjustments: [add], pieceSorts: [sort], productions: [runA, runB] };
  const broken = sizeBreaksIf([it], data, { ...data, productions: [runB] });
  assert(broken.length > 0, "PG1: deleting run A, whose offcut run B cut, is caught");
  const fine = sizeBreaksIf([it], data, { ...data, productions: [runA] });
  assert(
    fine.length === 0,
    `PG2: deleting the LATER run B breaks nothing — ${JSON.stringify(fine)}`,
  );
}
