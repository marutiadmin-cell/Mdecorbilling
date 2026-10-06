import type { BankTxn, CashAdjustment } from "@/types";

/**
 * The bank side(s) of a cash entry that is really one leg of a transfer.
 *
 * A transfer writes two records — one on each account — and they must be
 * edited and deleted as one thing. Newer ones carry a shared `transferId`, so
 * that is simply a lookup.
 *
 * Older ones do not, and they are the dangerous case: without recognising
 * them, the Cash page treats the cash side as an ordinary manual entry and
 * offers to EDIT it. Changing the amount there would move the cash and leave
 * the bank account saying something else — the books silently disagreeing
 * with themselves, which is worse than refusing the edit.
 *
 * They can still be recognised, because the transfer dialog wrote the SAME
 * note on both sides, on the same date, for the same amount — and the two
 * legs always point opposite ways: cash out pairs with money into a bank,
 * cash in with money out of one. All four have to agree before a record is
 * treated as a partner, and a partner has to actually be found: a manual
 * entry that merely happens to have "Transfer" in its note stays editable,
 * because there is nothing it could be out of step with.
 */
export function transferLegsFor(adj: CashAdjustment, bankTxns: BankTxn[]): BankTxn[] {
  if (adj.transferId) return bankTxns.filter((t) => t.transferId === adj.transferId);

  const note = (adj.reason ?? "").trim();
  if (!/^transfer\b/i.test(note)) return [];
  const wantBankSide = adj.type === "reduce" ? "deposit" : "withdraw";
  return bankTxns.filter(
    (t) =>
      (t.notes ?? "").trim() === note &&
      t.date === adj.date &&
      Math.abs(t.amount - adj.amount) < 0.005 &&
      t.type === wantBankSide,
  );
}

/**
 * The mirror image of `transferLegsFor`, from the bank side: the cash leg
 * of a bank entry that is really one leg of a transfer.
 *
 * Before this existed, the Bank account's own passbook could only offer to
 * edit a transfer when the row already carried a `transferId` — which an
 * older, bank-initiated transfer never got, since the id is only assigned
 * at the moment BOTH legs are first written together. That left an old
 * transfer editable from the Cash page (which always recognised it, via
 * `transferLegsFor`'s own heuristic) but completely unreachable from the
 * Bank page — not broken, just a dead end for whoever was looking at the
 * bank statement instead of the cash book. Same matching rule as
 * `transferLegsFor`: identical note, date and amount, with the two sides
 * always pointing opposite ways.
 */
export function cashLegFor(
  t: BankTxn,
  cashAdjustments: CashAdjustment[],
): CashAdjustment | undefined {
  if (t.transferId) return cashAdjustments.find((a) => a.transferId === t.transferId);

  const note = (t.notes ?? "").trim();
  if (!/^transfer\b/i.test(note)) return undefined;
  const wantCashSide = t.type === "deposit" ? "reduce" : "add";
  return cashAdjustments.find(
    (a) =>
      (a.reason ?? "").trim() === note &&
      a.date === t.date &&
      Math.abs(a.amount - t.amount) < 0.005 &&
      a.type === wantCashSide,
  );
}

/**
 * The OTHER leg of a bank-to-bank transfer (no cash involved at all) — same
 * matching rule again, but across every bank account rather than against a
 * single CashAdjustment, since both legs here are BankTxns and the whole
 * point is that they sit under two DIFFERENT accounts. `bankTxns` should be
 * every account's transactions, not just one — scoping it to a single
 * account would make a transfer's own two legs unable to ever find each
 * other.
 */
export function bankPartnerFor(t: BankTxn, bankTxns: BankTxn[]): BankTxn | undefined {
  if (t.transferId) return bankTxns.find((o) => o.id !== t.id && o.transferId === t.transferId);

  const note = (t.notes ?? "").trim();
  if (!/^transfer\b/i.test(note)) return undefined;
  const wantOtherSide = t.type === "deposit" ? "withdraw" : "deposit";
  return bankTxns.find(
    (o) =>
      o.id !== t.id &&
      o.bankId !== t.bankId &&
      (o.notes ?? "").trim() === note &&
      o.date === t.date &&
      Math.abs(o.amount - t.amount) < 0.005 &&
      o.type === wantOtherSide,
  );
}
