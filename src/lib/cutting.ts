/**
 * Cutting by-length stock — which pieces to cut a job's lengths from.
 *
 * The standard practice for linear stock (slats, rails, rods, pipes):
 *   - cut the LONGEST lengths first ("decreasing"),
 *   - each from the SMALLEST piece it fits in ("best fit") — so an offcut
 *     already lying around is used before a fresh full bar is opened, and a
 *     long bar is not chopped for a short cut while a shorter piece would do,
 *   - a piece already opened in this job is used again before any other,
 *   - each cut costs the saw's width (kerf),
 *   - what is left of each piece: at least the minimum usable length → back
 *     into stock as its own size; shorter → scrap (Cutting wastage).
 * When the sized pieces run out, the rest comes from unsorted length.
 *
 * Pure. Lengths are in the item's own unit throughout.
 */
import type { PieceCount } from "@/types";

/** Lengths compared and grouped at 1/10,000 — no float dust in a size. */
export const lenKey = (n: number) => Math.round(n * 10000) / 10000;
/** A size as it is LABELLED and kept: to the hundredth (0.01 ft = 1/8"),
 *  rounded DOWN — a piece is never shorter than its label says. Two
 *  leftovers of 1.1667 and 1.1666 ft are both a 1.16 ft piece, not two
 *  sizes that print the same. The sliver below the label is scrap. */
export const sizeKey = (n: number) => Math.floor(n * 100 + 1e-6) / 100;

export interface CutPlan {
  /** The lengths cut, grouped. */
  cuts: PieceCount[];
  /** Pieces taken from the sizes in stock. */
  taken: PieceCount[];
  /** Leftovers kept as new sizes. */
  returned: PieceCount[];
  /** Leftovers too short to keep. */
  scrap: number;
  /** Length cut from unsorted stock. */
  fromLoose: number;
  /** Length that had nowhere to come from (stock would go below zero). */
  short: number;
  /** Length this job takes out of stock in all: cuts + saw widths. Stock
   *  falls by used + scrap; taken + fromLoose = used + scrap + returned. */
  used: number;
  /** For the job card: each source piece and what was cut from it. */
  steps: { from: number | "loose"; cuts: number[]; left: number; kept: boolean }[];
}

const group = (lengths: number[]): PieceCount[] => {
  const m = new Map<number, number>();
  for (const l of lengths) m.set(lenKey(l), (m.get(lenKey(l)) ?? 0) + 1);
  return [...m].map(([length, count]) => ({ length, count })).sort((a, b) => b.length - a.length);
};

export function planCuts(
  cutLengths: number[],
  stock: PieceCount[],
  opts: { kerf?: number; minOffcut?: number; loose?: number } = {},
): CutPlan {
  const kerf = Math.max(0, opts.kerf ?? 0);
  const minOffcut = Math.max(0, opts.minOffcut ?? 0);
  let loose = Math.max(0, opts.loose ?? 0);

  // The sizes on hand, as a sorted multiset (shortest first, for best fit).
  const bags = stock
    .filter((p) => p.count > 0 && p.length > 0)
    .map((p) => ({ length: lenKey(p.length), count: Math.floor(p.count) }))
    .sort((a, b) => a.length - b.length);
  const takeFromBags = (need: number): number | null => {
    for (const b of bags)
      if (b.count > 0 && b.length + 1e-9 >= need) {
        b.count--;
        return b.length;
      }
    return null;
  };

  type Open = { from: number | "loose"; left: number; cuts: number[] };
  const open: Open[] = [];
  const takenLengths: number[] = [];
  let fromLoose = 0;
  let short = 0;
  let used = 0;

  const wanted = cutLengths.filter((l) => l > 0).sort((a, b) => b - a);
  for (const L of wanted) {
    // 1. A piece already opened in this job — the smallest it fits in.
    const reuse = open.filter((o) => o.left + 1e-9 >= L).sort((a, b) => a.left - b.left)[0];
    if (reuse) {
      reuse.cuts.push(L);
      const take = Math.min(reuse.left, L + kerf);
      reuse.left = lenKey(reuse.left - take);
      used += take;
      continue;
    }
    // 2. The smallest size on hand it fits in.
    const piece = takeFromBags(L);
    if (piece !== null) {
      takenLengths.push(piece);
      const take = Math.min(piece, L + kerf);
      open.push({ from: piece, left: lenKey(piece - take), cuts: [L] });
      used += take;
      continue;
    }
    // 3. Unsorted length — cut exactly what is needed, no leftover piece.
    const take = L + kerf;
    if (loose + 1e-9 >= take) loose = lenKey(loose - take);
    else {
      short += lenKey(take - loose);
      loose = 0;
    }
    fromLoose += take;
    used += take;
    open.push({ from: "loose", left: 0, cuts: [L] });
  }

  const returnedLengths: number[] = [];
  let scrap = 0;
  const steps: CutPlan["steps"] = [];
  for (const o of open) {
    const label = sizeKey(o.left);
    const kept = label > 0 && label + 1e-9 >= minOffcut && o.from !== "loose";
    if (kept) {
      returnedLengths.push(label);
      scrap += o.left - label; // the sliver under the label
    } else if (o.from !== "loose") scrap += o.left;
    steps.push({ from: o.from, cuts: o.cuts, left: o.left, kept });
  }

  const taken = group(takenLengths);
  const returned = group(returnedLengths);
  /* Stock is kept to 2 decimals (every stock move is). Lengths are exact to
     1/10,000, so a run that posted "used" and "scrap" at 4 decimals drifted
     from what Fix calculations rebuilds by a paisa-width each time. Post
     both at 2 decimals, the scrap as whatever the 2-decimal total leaves:
     used + scrap = what left stock, exactly. */
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const moved = r2(piecesLength(taken) + fromLoose - piecesLength(returned));
  const used2 = Math.min(r2(used), moved);
  return {
    cuts: group(wanted),
    taken,
    returned,
    scrap: Math.max(0, r2(moved - used2)),
    fromLoose: lenKey(fromLoose),
    short: lenKey(short),
    used: used2,
    steps,
  };
}

/** Total length of some pieces. */
export const piecesLength = (pieces: PieceCount[] | undefined) =>
  lenKey((pieces ?? []).reduce((s, p) => s + p.length * p.count, 0));
