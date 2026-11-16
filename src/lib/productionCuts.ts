/**
 * The cutting side of a production run: for each by-length material a
 * made-to-measure BOM cuts as pieces (BomComponent.cut), which pieces in
 * stock the run cuts from — worked out by lib/cutting.ts against the sizes
 * on hand (lib/pieces.ts).
 *
 * Editing a run plans as if the run had never happened: its own pieces are
 * back in their sizes (excludeProductionId) and its own length is back in
 * unsorted stock.
 */
import type { Bom, Item, Production, ProductionCut } from "@/types";
import type { MeasuredSize } from "@/lib/formula";
import { bomVars, resolveComponents } from "@/lib/sizing";
import { allBags, type PieceData } from "@/lib/pieces";
import { planCuts, type CutPlan } from "@/lib/cutting";

export interface RunCut {
  itemId: string;
  itemName: string;
  unit: string;
  plan: CutPlan;
}

export function planRunCuts(
  bom: Bom,
  size: MeasuredSize,
  pieces: number,
  items: Item[],
  data: PieceData,
  opts: { constants?: { key: string; value: number }[]; editing?: Production | null } = {},
): RunCut[] {
  if (!bom.sizing || !(pieces > 0)) return [];
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const { components } = resolveComponents(
    bom,
    bomVars(bom, size, opts.constants, {}, pieces),
    byId,
  );
  const bags = allBags(items, data, { excludeProductionId: opts.editing?.id });
  const out: RunCut[] = [];
  for (const c of components) {
    const it = byId.get(c.itemId);
    if (!it?.pieces || !c.cutCount || !c.cutLength) continue;
    const b = bags.get(it.id)!;
    const lengths = Array.from({ length: c.cutCount * pieces }, () => c.cutLength!);
    out.push({
      itemId: it.id,
      itemName: it.name,
      unit: it.unit,
      plan: planCuts(lengths, b.pieces, {
        kerf: it.pieces.kerf,
        minOffcut: it.pieces.minOffcut,
        // The replay already leaves the run being edited out.
        loose: b.loose,
      }),
    });
  }
  return out;
}

/** What is stored on the production record. */
export const toProductionCut = (r: RunCut): ProductionCut => ({
  itemId: r.itemId,
  cuts: r.plan.cuts,
  taken: r.plan.taken,
  returned: r.plan.returned,
  scrap: r.plan.scrap,
  fromLoose: r.plan.fromLoose,
});
