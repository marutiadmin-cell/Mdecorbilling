import { ItemRepo } from "@/repositories";
import type { Invoice, LineItem } from "@/types";

/**
 * Aggregates quantity needed per item across `lines` and checks it against
 * current stock. `reverseLines` (an existing sale/bill's original line
 * items, when editing) are added back first, since that qty is about to be
 * un-deducted in the same save. Returns one readable message per item that
 * would go negative — empty when nothing would.
 */
export function stockShortfalls(lines: LineItem[], reverseLines: LineItem[] = []): string[] {
  const needed = new Map<string, number>();
  for (const l of lines) needed.set(l.itemId, (needed.get(l.itemId) ?? 0) + l.qty);
  const reversed = new Map<string, number>();
  for (const l of reverseLines) reversed.set(l.itemId, (reversed.get(l.itemId) ?? 0) + l.qty);

  const out: string[] = [];
  for (const [itemId, qty] of needed) {
    const it = ItemRepo.get(itemId);
    if (!it) continue;
    const available = it.stock + (reversed.get(itemId) ?? 0);
    if (available - qty < 0) {
      out.push(`${it.name} (have ${available} ${it.unit}, need ${qty})`);
    }
  }
  return out;
}

/**
 * Each item's LAST purchase rate: the price on its newest purchase line, by
 * bill date and then entry time — so a backdated bill entered today does not
 * become the "last" price, and deleting the newest bill hands the title back
 * to the one before it.
 */
export function latestPurchaseRates(
  purchases: Pick<Invoice, "date" | "createdAt" | "lineItems">[],
): Map<string, number> {
  const best = new Map<string, { date: string; created: string; price: number }>();
  for (const p of purchases) {
    for (const l of p.lineItems) {
      if (!l.itemId || !(l.price > 0)) continue;
      const cur = best.get(l.itemId);
      const created = p.createdAt || "";
      if (!cur || p.date > cur.date || (p.date === cur.date && created >= cur.created))
        best.set(l.itemId, { date: p.date, created, price: l.price });
    }
  }
  return new Map([...best].map(([id, b]) => [id, b.price] as const));
}
