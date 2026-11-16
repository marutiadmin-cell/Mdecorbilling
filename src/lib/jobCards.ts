/**
 * Job cards — one per measured window on an order, for the workshop.
 *
 * Made from a quotation's or proforma's (or a bill's) lines that carry a
 * size: one card per line, numbered from Settings → Manufacturing's prefix
 * (WB-0001…), starting at the first stage. A line that already has a card
 * gets no second one, so "Create job cards" can be pressed again safely
 * after lines are added to the order.
 */
import type { JobCard, LineItem } from "@/types";
import { nextInvoiceNumber } from "@/repositories";
import { today } from "@/lib/format";
import type { mtmOf } from "@/lib/mtm";

export interface OrderLike {
  id: string;
  number: string;
  partyId?: string;
  partyName: string;
  partyPhone?: string;
  partyAddress?: string;
  lineItems: LineItem[];
}

export function cardsForOrder(
  kind: NonNullable<JobCard["sourceKind"]>,
  doc: OrderLike,
  existing: JobCard[],
  mtm: ReturnType<typeof mtmOf>,
): Omit<JobCard, "id" | "createdAt">[] {
  const made: Omit<JobCard, "id" | "createdAt">[] = [];
  const now = new Date().toISOString();
  for (const l of doc.lineItems) {
    if (!l.size) continue;
    if (existing.some((c) => c.sourceId === doc.id && c.lineId === l.id)) continue;
    made.push({
      number: nextInvoiceNumber(mtm.jobPrefix, [...existing, ...made] as { number: string }[]),
      date: today(),
      stage: mtm.jobStages[0],
      history: [{ stage: mtm.jobStages[0], at: now }],
      partyId: doc.partyId || undefined,
      partyName: doc.partyName,
      partyPhone: doc.partyPhone || undefined,
      partyAddress: doc.partyAddress || undefined,
      sourceKind: kind,
      sourceId: doc.id,
      sourceNumber: doc.number,
      lineId: l.id,
      finishedItemId: l.itemId,
      finishedItemName: l.name,
      bomId: l.size.bomId,
      size: { w: l.size.w, h: l.size.h, unit: l.size.unit },
      pieces: l.size.pieces || 1,
      qty: l.qty,
      type: l.size.type,
      operateSide: l.size.operateSide,
      serial: l.size.serial,
      note: l.size.note,
    });
  }
  return made;
}

/** Lines of an order that are measured but have no job card yet. */
export const linesWithoutCard = (doc: OrderLike, existing: JobCard[]) =>
  doc.lineItems.filter(
    (l) => l.size && !existing.some((c) => c.sourceId === doc.id && c.lineId === l.id),
  );

/** "W57.25 H139" — as the shop writes it on the card. */
export const cardSize = (c: Pick<JobCard, "size">) => {
  const n = (x: number) => String(Math.round((Number(x) || 0) * 100) / 100);
  const u = c.size.unit === "in" ? "" : ` ${c.size.unit}`;
  return `W${n(c.size.w)}${u} H${n(c.size.h)}${u}`;
};

/** The card as text — for WhatsApp to the karigar. */
export function jobCardText(c: JobCard, companyName: string): string {
  return [
    `*${companyName} Order Detail*`,
    `*Job Number: ${c.number}*`,
    `Date: ${c.date}`,
    `Customer: ${c.partyName}`,
    c.partyAddress ? `Address: ${c.partyAddress}` : null,
    c.partyPhone ? `Mobile: ${c.partyPhone}` : null,
    "",
    c.serial ? `Serial Number: ${c.serial}` : null,
    c.type ? `Type: ${c.type}` : null,
    `Operate Side: ${c.operateSide ?? "—"}`,
    `Size (W*H): ${cardSize(c)}${c.pieces > 1 ? ` × ${c.pieces} pcs` : ""}`,
    c.note ? `Note: ${c.note}` : null,
    c.dueDate ? `Ready by: ${c.dueDate}` : null,
  ]
    .filter((x) => x !== null)
    .join("\n");
}
