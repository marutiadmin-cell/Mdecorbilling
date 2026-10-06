import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { matchesQuery } from "@/lib/search";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import {
  SalesRepo,
  PurchaseRepo,
  ExpenseRepo,
  PaymentRepo,
  CashAdjustmentRepo,
  BankTxnRepo,
  BankRepo,
  JournalVoucherRepo,
} from "@/repositories";
import type { CashAdjustment } from "@/types";
import { newBatch, commitBatch } from "@/repositories/base";
import { useRepoData } from "@/hooks/useRepoData";
import { useFinancialYear } from "@/store/financialYear";
import { cashFlows, type FlowEntry } from "@/lib/ledger";
import { transferLegsFor } from "@/lib/transferLegs";
import { fmtMoney, fmtDate, today, fmtDateShort } from "@/lib/format";
import { DataTable } from "@/components/DataTable";
import { usePagination } from "@/hooks/usePagination";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/Field";
import { NumField } from "@/components/NumInput";
import {
  Banknote,
  Search,
  Calendar,
  X,
  SlidersHorizontal,
  ArrowLeftRight,
  ArrowRight,
  Pencil,
  Trash2,
  ExternalLink,
} from "lucide-react";
import { CashBankTransferDialog } from "@/components/CashBankTransferDialog";
import { toast } from "sonner";
import { usePermissions } from "@/hooks/usePermissions";

export const Route = createFileRoute("/cash")({ component: CashPage });

function CashPage() {
  const { isOwner, canEdit } = usePermissions();
  const editAllowed = isOwner || canEdit("cashBank");
  const [entries, setEntries] = useState<FlowEntry[]>([]);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [editAdj, setEditAdj] = useState<CashAdjustment | null>(null);
  const [editTransfer, setEditTransfer] = useState<CashAdjustment | null>(null);
  const [q, setQ] = useState("");
  const { key: fyKey, from: fyFrom, to: fyTo } = useFinancialYear();
  const [dateFrom, setDateFrom] = useState(fyFrom);
  const [dateTo, setDateTo] = useState(fyTo);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  // Follow the Topbar's Financial Year selector by default — but only while
  // this page's range still IS the previous FY's default. The moment
  // someone types a custom range, switching FY must not silently discard it.
  const prevFY = useRef({ key: fyKey, from: fyFrom, to: fyTo });
  useEffect(() => {
    const prev = prevFY.current;
    if (prev.key !== fyKey && dateFrom === prev.from && dateTo === prev.to) {
      setDateFrom(fyFrom);
      setDateTo(fyTo);
    }
    prevFY.current = { key: fyKey, from: fyFrom, to: fyTo };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fyKey, fyFrom, fyTo]);

  const refresh = () =>
    setEntries(
      cashFlows(
        SalesRepo.all(),
        PurchaseRepo.all(),
        ExpenseRepo.all(),
        PaymentRepo.all(),
        CashAdjustmentRepo.all(),
        JournalVoucherRepo.all(),
      ),
    );
  const _repoV = useRepoData();
  useEffect(refresh, [_repoV]);

  /**
   * Remove a manual cash entry — and everything that entry is half of.
   *
   * A plain adjustment is its own record and simply goes. A TRANSFER leg is
   * not: it was written together with a bank deposit or withdrawal, and
   * deleting one side alone would leave the money out of one account and
   * never into the other. Both legs go on one batch, and the bank balance is
   * put back by the same amount it was moved.
   */
  const deleteRow = (row: FlowEntry) => {
    const id = row.source?.kind === "adjustment" ? row.source.id : null;
    if (!id) return;
    const adj = CashAdjustmentRepo.get(id);
    if (!adj) return;

    const legs = transferLegsFor(adj, BankTxnRepo.all());
    const what = legs.length
      ? `Delete this transfer? It will be removed from cash AND from ${legs
          .map((t) => BankRepo.get(t.bankId)?.name ?? "the bank account")
          .join(", ")}.`
      : `Delete this cash entry of ${fmtMoney(adj.amount)}?`;
    if (!confirm(what)) return;

    const batch = newBatch();
    CashAdjustmentRepo.removeBatched(batch, adj.id);
    for (const leg of legs) {
      BankTxnRepo.removeBatched(batch, leg.id);
      // Put the account back where it was: a deposit added, so removing it
      // subtracts, and the other way round.
      BankRepo.adjustFieldBatched(
        batch,
        leg.bankId,
        "balance",
        leg.type === "deposit" ? -leg.amount : leg.amount,
      );
    }
    commitBatch(batch, "delete cash entry").then((ok) => {
      if (!ok) {
        toast.error("Could not delete — reload and check before trying again");
        return;
      }
      toast.success(legs.length ? "Transfer deleted from both accounts" : "Cash entry deleted");
      refresh();
    });
  };

  // Balance is the true running cash-in-hand as of now — it doesn't change
  // when a date range is applied, only the period's In/Out totals do.
  const balance = entries.reduce((s, e) => s + e.in - e.out, 0);

  const dateFiltered = useMemo(() => {
    if (!dateFrom && !dateTo) return entries;
    return entries.filter(
      (e) => (!dateFrom || e.date >= dateFrom) && (!dateTo || e.date <= dateTo),
    );
  }, [entries, dateFrom, dateTo]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return dateFiltered;
    return dateFiltered.filter((e) => matchesQuery(s, e.type, e.ref));
  }, [dateFiltered, q]);

  // Footer In/Out cover the filtered rows the table actually shows (date
  // range AND search) — `balance` above stays all-time by design.
  const totalIn = filtered.reduce((s, e) => s + e.in, 0);
  const totalOut = filtered.reduce((s, e) => s + e.out, 0);

  const pg = usePagination(filtered, "cash");

  return (
    <div className="flex flex-col h-full bg-[#f5f6fa]">
      <PageHeader
        title="Cash"
        subtitle={`${filtered.length} of ${entries.length} transactions`}
        icon={<Banknote className="h-5 w-5" />}
        mobileAction={
          <button
            onClick={() => setMobileFiltersOpen(true)}
            className="relative h-9 w-9 flex items-center justify-center rounded-lg border border-gray-200 bg-gray-50/60 text-gray-600"
            title="Filters"
          >
            <SlidersHorizontal className="h-4 w-4" />
            {(dateFrom !== fyFrom || dateTo !== fyTo) && (
              <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-primary" />
            )}
          </button>
        }
        actions={
          <>
            {/* Date range — its own filter sheet on mobile (see Filters
                button above); this inline row is desktop only. */}
            <div className="hidden sm:flex items-center gap-1.5 h-9 pl-3 pr-2.5 rounded-lg border border-gray-200 bg-gray-50/60 shrink-0">
              <Calendar className="h-3.5 w-3.5 text-gray-400 shrink-0" />
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="bg-transparent text-xs text-gray-700 focus:outline-none w-[104px]"
              />
              <span className="text-gray-300 text-xs">–</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="bg-transparent text-xs text-gray-700 focus:outline-none w-[104px]"
              />
              {(dateFrom !== fyFrom || dateTo !== fyTo) && (
                <button
                  onClick={() => {
                    setDateFrom("");
                    setDateTo("");
                  }}
                  className="text-gray-400 hover:text-gray-600 transition"
                  title="Clear date range"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="relative w-full sm:w-56">
              <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search type, reference…"
                className="w-full h-9 pl-9 pr-3 rounded-lg border border-gray-200 bg-gray-50/60 text-base md:text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/20 focus:bg-white transition"
              />
            </div>
            {editAllowed && (
              <>
                {/* "Put the day's takings in the bank" had no home on this
                    page at all — it was a checkbox inside one bank account's
                    Deposit action. */}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setTransferOpen(true)}
                  className="w-full sm:w-auto"
                >
                  <ArrowLeftRight className="h-3.5 w-3.5" /> Transfer
                </Button>
                <Button size="sm" onClick={() => setAdjustOpen(true)} className="w-full sm:w-auto">
                  <Banknote className="h-3.5 w-3.5" /> Adjust Cash
                </Button>
              </>
            )}
          </>
        }
      />

      {/* Mobile filter sheet — Date Range doesn't fit inline next to Search
          on a phone, so it lives here behind the header's Filters button
          instead, same state as the desktop inline control. */}
      <Dialog open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Filters</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-gray-500 block mb-1.5">Date Range</label>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="flex-1 h-9 px-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <span className="text-gray-300">–</span>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="flex-1 h-9 px-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
            <div className="flex items-center justify-between pt-1">
              {dateFrom !== fyFrom || dateTo !== fyTo ? (
                <button
                  onClick={() => {
                    setDateFrom("");
                    setDateTo("");
                  }}
                  className="text-xs text-gray-400 hover:text-gray-600 transition flex items-center gap-1"
                >
                  <X className="h-3 w-3" /> Clear
                </button>
              ) : (
                <span />
              )}
              <button
                onClick={() => setMobileFiltersOpen(false)}
                className="h-8 px-4 bg-primary text-primary-foreground rounded-md text-sm font-semibold hover:opacity-90 transition"
              >
                Done
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Mobile card list — a table of 5 columns doesn't fit a phone; this is
          the same data as one row-card per transaction instead (read-only, same
          as the desktop table — no click action here either). */}
      <div className="md:hidden flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <Banknote className="h-10 w-10 mx-auto mb-3 text-gray-200" />
            <p className="font-medium">No cash transactions yet</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pg.paged.map((e, i) => (
              <div
                key={`${e.date}-${e.type}-${e.ref}-${e.in}-${e.out}-${i}`}
                className="bg-white p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-800 truncate">{e.type}</p>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">
                      {fmtDate(e.date)} · {e.ref}
                    </p>
                  </div>
                  <p
                    className={`font-bold tabular-nums shrink-0 ${e.in ? "text-emerald-600" : e.out ? "text-rose-600" : "text-gray-800"}`}
                  >
                    {e.in ? `+${fmtMoney(e.in)}` : e.out ? `−${fmtMoney(e.out)}` : "—"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="hidden md:flex flex-1 min-h-0 p-6">
        <DataTable
          storageKey="cash"
          columns={[
            {
              key: "date",
              label: "Date",
              render: (e) => fmtDateShort(e.date),
              sortValue: (e) => e.date,
            },
            {
              key: "type",
              label: "Type",
              render: (e) => e.type,
              sortValue: (e) => e.type,
            },
            {
              key: "ref",
              label: "Reference",
              render: (e) => e.ref,
              sortValue: (e) => e.ref,
            },
            {
              key: "in",
              label: "Cash In",
              align: "right",
              render: (e) => <span className="tabular-nums">{e.in ? fmtMoney(e.in) : "—"}</span>,
              sortValue: (e) => e.in,
            },
            {
              key: "out",
              label: "Cash Out",
              align: "right",
              render: (e) => <span className="tabular-nums">{e.out ? fmtMoney(e.out) : "—"}</span>,
              sortValue: (e) => e.out,
            },
            {
              key: "action",
              label: "Action",
              width: "84px",
              align: "center",
              render: (e) => (
                <CashRowActions
                  row={e}
                  onEdit={(adj) =>
                    transferLegsFor(adj, BankTxnRepo.all()).length > 0
                      ? setEditTransfer(adj)
                      : setEditAdj(adj)
                  }
                  onDelete={deleteRow}
                />
              ),
            },
          ]}
          rows={filtered}
          rowKey={(e) => e.source?.id ?? `${e.date}-${e.type}-${e.ref}-${e.in}-${e.out}`}
          emptyMessage={
            entries.length === 0 ? "No cash transactions yet" : "No matches for your search"
          }
          footer={
            <tr>
              <td colSpan={3}>
                Total <span className="text-gray-300">|</span>{" "}
                <span className="tabular-nums">{fmtMoney(balance)}</span>
              </td>
              <td className="text-right tabular-nums">{fmtMoney(totalIn)}</td>
              <td className="text-right tabular-nums">{fmtMoney(totalOut)}</td>
            </tr>
          }
        />
      </div>
      <CashBankTransferDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        onSaved={refresh}
        editing={editTransfer}
        onEditingDone={() => setEditTransfer(null)}
      />
      <CashAdjustDialog
        editing={editAdj}
        onEditingChange={setEditAdj}
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        onSaved={refresh}
        currentBalance={balance}
      />
    </div>
  );
}

/**
 * What a cash row can actually be asked to do.
 *
 * Only a manual adjustment owns itself. Every other line here is the cash
 * side of a bill, an expense or a payment — the number is real, but it is
 * that document's number, so the honest action is to open the document
 * rather than to pretend the cash line can be edited on its own.
 */
function CashRowActions({
  row,
  onEdit,
  onDelete,
}: {
  row: FlowEntry;
  onEdit: (a: CashAdjustment) => void;
  onDelete: (row: FlowEntry) => void;
}) {
  const navigate = useNavigate();
  const src = row.source;
  if (!src) return <span className="text-gray-300">—</span>;

  if (src.kind === "adjustment") {
    const adj = CashAdjustmentRepo.get(src.id);
    // A transfer leg is editable only as a whole, from the transfer itself —
    // changing one side's amount here would move the cash and leave the bank
    // account saying something else. Recognised by its partner record, not by
    // a flag, so transfers made before the two legs were stamped with a
    // shared id are refused too. Those are the ones that mattered: they were
    // being offered for edit.
    const isTransfer = !!adj && transferLegsFor(adj, BankTxnRepo.all()).length > 0;
    return (
      <span
        className="inline-flex items-center justify-center gap-0.5"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => adj && onEdit(adj)}
          disabled={!adj}
          title={isTransfer ? "Edit this transfer (both accounts)" : "Edit entry"}
          className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-primary-soft hover:text-primary hover:border-primary/25 disabled:opacity-30 disabled:pointer-events-none"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => onDelete(row)}
          title={isTransfer ? "Delete this transfer from both accounts" : "Delete entry"}
          className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </span>
    );
  }

  const to =
    src.kind === "sale"
      ? `/sales/${src.id}`
      : src.kind === "purchase"
        ? `/purchase/${src.id}`
        : src.kind === "expense"
          ? "/expenses"
          : src.kind === "journal"
            ? "/journal-vouchers"
            : "/payments";
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigate({ to });
      }}
      title={`This came from a ${src.kind} — open it to change it`}
      className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-primary-soft hover:text-primary hover:border-primary/25"
    >
      <ExternalLink className="h-3.5 w-3.5" />
    </button>
  );
}

function CashAdjustDialog({
  open,
  onOpenChange,
  onSaved,
  currentBalance,
  editing,
  onEditingChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
  currentBalance: number;
  /** An existing manual entry being corrected, rather than a new one. */
  editing?: CashAdjustment | null;
  onEditingChange?: (v: CashAdjustment | null) => void;
}) {
  const [type, setType] = useState<"add" | "reduce">("add");
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  // Editing is the same form, opened over an existing row.
  const isOpen = open || !!editing;
  const close = (v: boolean) => {
    if (v) return;
    onEditingChange?.(null);
    onOpenChange(false);
  };

  useEffect(() => {
    if (!isOpen) return;
    setType(editing?.type ?? "add");
    setAmount(editing?.amount ?? 0);
    setDate(editing?.date ?? today());
    setReason(editing?.reason ?? "");
    setSaving(false);
  }, [isOpen, editing]);

  const n = amount;
  const signed = (t: "add" | "reduce", amt: number) => (t === "add" ? amt : -amt);
  const nextBalance =
    Math.round(
      (currentBalance - (editing ? signed(editing.type, editing.amount) : 0) + signed(type, n)) *
        100,
    ) / 100;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (n <= 0) {
      toast.error("Enter amount to adjust");
      return;
    }
    setSaving(true);
    if (editing) {
      CashAdjustmentRepo.update(editing.id, {
        date,
        type,
        amount: n,
        reason: reason.trim() || undefined,
      });
      toast.success(`Cash entry updated: ${fmtMoney(n)}`);
    } else {
      CashAdjustmentRepo.add({ date, type, amount: n, reason: reason.trim() || undefined });
      toast.success(`Cash ${type === "add" ? "added" : "reduced"}: ${fmtMoney(n)}`);
    }
    onSaved();
    close(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Cash Entry" : "Add Cash Entry"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="space-y-3.5">
          {/* "Cash In" and "Cash Out" — the words the table's own columns use.
              This was two big buttons reading "+ Add Cash" / "− Reduce Cash",
              which look like actions about to happen: fine on a blank form,
              meaningless sitting on an entry that was made days ago, where
              the only question is which way it already went. A labelled
              two-state control answers that question instead of appearing to
              offer two things to do. */}
          <label className="block">
            <span className="text-[12px] font-medium text-muted-foreground block mb-1">
              Direction
            </span>
            <div
              role="radiogroup"
              aria-label="Direction"
              className="grid grid-cols-2 rounded-md border border-input overflow-hidden"
            >
              {(
                [
                  ["add", "Cash In"],
                  ["reduce", "Cash Out"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={type === key}
                  onClick={() => setType(key)}
                  className={`h-9 text-[13px] font-semibold transition ${
                    type === key
                      ? key === "add"
                        ? "bg-emerald-600 text-white"
                        : "bg-rose-600 text-white"
                      : "bg-background text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <NumField label="Amount (₹) *" value={amount} onValue={setAmount} />
            <Field
              label="Date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <Field
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Opening cash, owner drawing, counting correction…"
          />

          {/* What this will DO, not what the balance happens to be. On an edit
              the useful number is where cash in hand ends up, which is the
              current figure with the old entry swapped for the new one. */}
          <div className="text-[12px] bg-muted/50 border rounded-md px-3 py-2 flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Cash in hand</span>
            <span className="flex items-center gap-2">
              <span className="tabular-nums">{fmtMoney(currentBalance)}</span>
              {nextBalance !== currentBalance && (
                <>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  <span
                    className={`font-semibold tabular-nums ${
                      nextBalance > currentBalance ? "text-emerald-700" : "text-rose-700"
                    }`}
                  >
                    {fmtMoney(nextBalance)}
                  </span>
                </>
              )}
            </span>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : editing ? "Save Changes" : "Add Entry"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
