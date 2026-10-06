import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { matchesQuery } from "@/lib/search";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  PurchaseRepo,
  PartyRepo,
  ItemRepo,
  PaymentRepo,
  JournalVoucherRepo,
  BankRepo,
  PurchaseReturnRepo,
} from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";
import { newBatch, commitBatch } from "@/repositories/base";
import type { Invoice } from "@/types";
import { fmtDate, fmtDateShort, fmtMoney } from "@/lib/format";
import { useFinancialYear } from "@/store/financialYear";
import {
  Plus,
  Search,
  X,
  ChevronDown,
  Trash2,
  Pencil,
  FileText,
  SlidersHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import { bankParts, describePayment } from "@/lib/paymentSplit";
import { PaginationBar } from "@/components/Pagination";
import { usePagination } from "@/hooks/usePagination";
import { DataTable } from "@/components/DataTable";
import { fmtMode } from "@/lib/paymentMode";
import { PageHeader } from "@/components/PageHeader";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePermissions } from "@/hooks/usePermissions";

/** An account's name for display. The word "Bank" three times over is
 *  exactly what a split is meant to stop being ambiguous. */
const bankName = (id: string) => BankRepo.get(id)?.name;

export const Route = createFileRoute("/purchase/")({ component: PurchasePage });

type Status = "all" | "paid" | "partial" | "unpaid";

// Keeps the filters selected everywhere — across leaving to view/edit a
// purchase, across leaving to a different page entirely and coming back,
// anything short of an actual page reload (which starts fresh again).
let filterCache: {
  dateFrom: string;
  dateTo: string;
  partyId: string;
  status: Status;
  search: string;
  fyKey: string;
} | null = null;

function PurchasePage() {
  const navigate = useNavigate();
  const { isOwner, canEdit, canDelete } = usePermissions();
  const editAllowed = isOwner || canEdit("purchaseExpenses");
  const deleteAllowed = isOwner || canDelete("purchaseExpenses");
  const [rows, setRows] = useState<Invoice[]>([]);
  const [parties, setParties] = useState<{ id: string; name: string }[]>([]);
  const { key: fyKey, from: fyFrom, to: fyTo } = useFinancialYear();
  /* Opens on the current Financial Year, not everything — matches Tally/Zoho
   * Books. The saved filter still wins when there is one — a range somebody
   * chose survives navigating away and back, and switching the Topbar's FY
   * only moves this range when it still equals the previous FY's default
   * (see the follow-effect below). */
  const [dateFrom, setDateFrom] = useState(() => filterCache?.dateFrom ?? fyFrom);
  const [dateTo, setDateTo] = useState(() => filterCache?.dateTo ?? fyTo);
  const [partyId, setPartyId] = useState(() => filterCache?.partyId ?? "all");
  const [status, setStatus] = useState<Status>(() => filterCache?.status ?? "all");
  const [search, setSearch] = useState(() => filterCache?.search ?? "");
  const [showPartyDrop, setShowPartyDrop] = useState(false);
  const [partyDropQ, setPartyDropQ] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const refresh = () => {
    setRows(PurchaseRepo.all());
    setParties(PartyRepo.all().map((p) => ({ id: p.id, name: p.name })));
  };
  const _repoV = useRepoData();
  useEffect(refresh, [_repoV]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (dateFrom && r.date < dateFrom) return false;
      if (dateTo && r.date > dateTo) return false;
      if (partyId !== "all" && r.partyId !== partyId) return false;
      if (status !== "all") {
        const bal = Math.round((r.total - r.paid) * 100) / 100;
        if (status === "paid" && bal > 0) return false;
        if (status === "unpaid" && r.paid > 0) return false;
        if (status === "partial" && (r.paid === 0 || bal <= 0)) return false;
      }
      if (search) {
        const q = search.toLowerCase();
        if (!matchesQuery(q, r.number, r.partyName)) return false;
      }
      return true;
    });
  }, [rows, dateFrom, dateTo, partyId, status, search]);

  const pg = usePagination(filtered, "purchase");
  const totalAmount = filtered.reduce((a, r) => a + r.total, 0);
  const totalPaid = filtered.reduce((a, r) => a + r.paid, 0);
  const totalPayable = filtered.reduce((a, r) => a + Math.max(0, r.total - r.paid), 0);
  const paidCount = filtered.filter((r) => r.total - r.paid <= 0).length;
  const unpaidCount = filtered.filter((r) => r.paid === 0 && r.total > 0).length;
  const partialCount = filtered.filter((r) => r.paid > 0 && r.total - r.paid > 0).length;

  const selectedParty = parties.find((p) => p.id === partyId);

  // Local search over the dropdown only — must never overwrite `parties`
  // itself, or the master list (used for `selectedParty` lookup and "All
  // Suppliers") gets stuck as whatever subset was last typed/searched.
  const filteredDropdownParties = useMemo(() => {
    const q = partyDropQ.trim().toLowerCase();
    return q ? parties.filter((p) => p.name.toLowerCase().includes(q)) : parties;
  }, [parties, partyDropQ]);

  const clearFilters = () => {
    setDateFrom(fyFrom);
    setDateTo(fyTo);
    setPartyId("all");
    setStatus("all");
    setSearch("");
  };
  const filtersActive =
    dateFrom !== fyFrom ||
    dateTo !== fyTo ||
    partyId !== "all" ||
    status !== "all" ||
    search !== "";

  useEffect(() => {
    filterCache = { dateFrom, dateTo, partyId, status, search, fyKey };
  }, [dateFrom, dateTo, partyId, status, search, fyKey]);

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

  const handleDelete = (r: Invoice) => {
    if (!deleteAllowed) {
      toast.error("You don't have permission to delete purchases");
      return;
    }
    // A purchase return debits stock and the supplier's balance against THIS
    // bill. Deleting the bill underneath it would orphan the return — the
    // debit survives with no matching purchase, throwing off the supplier
    // balance and double-counting stock. Block until the return is removed.
    const linkedReturns = PurchaseReturnRepo.all().filter(
      (ret) => (ret.originalRef ?? "").trim() === r.number.trim(),
    );
    if (linkedReturns.length) {
      toast.error(
        `Can't delete ${r.number} — it has ${linkedReturns.length} purchase return(s) against it (${linkedReturns
          .map((x) => x.number)
          .join(", ")}). Delete the return(s) first.`,
      );
      return;
    }
    if (
      !confirm(
        `Delete bill ${r.number}? Purchased quantities will be removed from stock, and any payments applied to it will become advance payments.`,
      )
    )
      return;
    // Another device (or a stale row) may have already deleted this bill.
    // Re-read the live doc and bail if it's gone — the stock/bank reversals
    // below are blind atomic increments, so running them a second time would
    // double-remove stock and double-reverse the bank balance. Reverse from
    // the LIVE doc, not the possibly-stale list row.
    const live = PurchaseRepo.get(r.id);
    if (!live) {
      toast.info(`Bill ${r.number} was already deleted`);
      refresh();
      return;
    }
    // Stock restore, payment unlinking, and the bill delete must land
    // together — a shared batch commits them as one atomic Firestore write.
    const batch = newBatch();
    // Reverse the stock addition this purchase made
    for (const l of live.lineItems) {
      const it = ItemRepo.get(l.itemId);
      if (it) ItemRepo.adjustFieldBatched(batch, it.id, "stock", -l.qty);
    }
    // Payments applied to this bill: unlink them so the money stays
    // counted as an advance instead of silently disappearing
    for (const p of PaymentRepo.all()) {
      if (p.allocations?.some((a) => a.invoiceId === live.id)) {
        const remaining = p.allocations.filter((a) => a.invoiceId !== live.id);
        PaymentRepo.updateBatched(batch, p.id, {
          allocations: remaining.length ? remaining : undefined,
        });
      } else if (p.ref) {
        // Legacy payments (saved before allocations existed) named this bill
        // by number in a comma-separated `ref` string instead — not covered
        // by the allocations check above. Left alone, the party ledger would
        // keep showing "paid against {number}" for a bill that no longer
        // exists.
        const num = live.number.trim();
        const tokens = p.ref
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        if (tokens.includes(num)) {
          const remaining = tokens.filter((t) => t !== num);
          PaymentRepo.updateBatched(batch, p.id, {
            ref: remaining.length ? remaining.join(", ") : undefined,
          });
        }
      }
    }
    // Journal Voucher bill-wise adjustments against this bill: strip them
    // so a JV doesn't keep pointing at a bill that no longer exists — same
    // cleanup Payment allocations get above, for the same reason: the bill
    // is going away, so there's no `paid` field left for that allocation to
    // mean anything against.
    for (const jv of JournalVoucherRepo.all()) {
      if (!jv.lines.some((l) => l.allocations?.some((a) => a.docId === live.id))) continue;
      const nextLines = jv.lines.map((l) => {
        if (!l.allocations?.some((a) => a.docId === live.id)) return l;
        const remaining = l.allocations.filter((a) => a.docId !== live.id);
        return { ...l, allocations: remaining.length ? remaining : undefined };
      });
      JournalVoucherRepo.updateBatched(batch, jv.id, { lines: nextLines });
    }
    // Undo whatever this bill moved out of a specific bank account at
    // billing time, or that account's balance stays permanently wrong
    // after delete.
    // Every account it touched, not just one: a split purchase can name two,
    // and leaving either behind makes that balance permanently wrong.
    for (const [bankId, amount] of bankParts(live)) {
      BankRepo.adjustFieldBatched(batch, bankId, "balance", amount);
    }
    PurchaseRepo.removeBatched(batch, live.id);
    commitBatch(batch, "delete purchase");
    refresh();
    toast.success("Bill deleted — stock adjusted");
  };

  const STATUSES: { value: Status; label: string }[] = [
    { value: "all", label: "All" },
    { value: "paid", label: "Paid" },
    { value: "partial", label: "Partial" },
    { value: "unpaid", label: "Unpaid" },
  ];

  return (
    <div className="flex flex-col h-full bg-[#f5f6fa]">
      <PageHeader
        title="Purchase"
        subtitle={`${filtered.length} of ${rows.length} bills`}
        icon={<FileText className="h-5 w-5" />}
        iconClassName="text-warning"
        mobileAction={
          <button
            onClick={() => setFiltersOpen(true)}
            className="relative h-9 w-9 flex items-center justify-center rounded-lg border border-gray-200 bg-gray-50/60 text-gray-600"
            title="Filters"
          >
            <SlidersHorizontal className="h-4 w-4" />
            {filtersActive && (
              <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-primary" />
            )}
          </button>
        }
        actions={
          <>
            {/* One button, one panel. The date range, the party picker
                and the status pills used to sit across this toolbar —
                first thing to wrap on a laptop, and already duplicated
                inside the filter dialog. They live in the dialog only
                now, on every screen size. */}
            <button
              onClick={() => setFiltersOpen(true)}
              className="hidden sm:flex relative items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 bg-gray-50/60 text-[13px] text-gray-700 hover:bg-gray-100 transition"
              title="Filters"
            >
              <SlidersHorizontal className="h-4 w-4 text-gray-500" />
              Filters
              {filtersActive && <span className="ml-0.5 h-2 w-2 rounded-full bg-primary" />}
            </button>

            {/* Search — the one filter kept inline on every screen size */}
            <div className="relative w-full sm:w-48">
              <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search bill, supplier..."
                className="w-full h-9 pl-9 pr-3 rounded-lg border border-gray-200 bg-gray-50/60 text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/20 focus:bg-white transition"
              />
            </div>

            {editAllowed && (
              <button
                onClick={() => navigate({ to: "/purchase/new" })}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 h-9 px-4 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:opacity-90 transition"
              >
                <Plus className="h-4 w-4" /> Add Purchase
              </button>
            )}
          </>
        }
      />

      {/* Mobile filter sheet — Date Range/Supplier/Status don't fit inline
          next to Search on a phone, so they live here behind the header's
          Filters button instead, same state as the desktop inline controls. */}
      <Dialog open={filtersOpen} onOpenChange={setFiltersOpen}>
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
            <div>
              <label className="text-xs font-semibold text-gray-500 block mb-1.5">Supplier</label>
              <div className="relative">
                <button
                  onClick={() => setShowPartyDrop((v) => !v)}
                  className="w-full flex items-center gap-2 h-9 border border-gray-200 rounded-lg text-sm px-3 text-gray-700 bg-gray-50/60 hover:bg-gray-100 transition"
                >
                  <span className="flex-1 text-left truncate">
                    {selectedParty ? selectedParty.name : "All Suppliers"}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                </button>
                {showPartyDrop && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-30 max-h-52 overflow-auto">
                    <div className="p-2 border-b">
                      <input
                        autoFocus
                        placeholder="Search supplier..."
                        value={partyDropQ}
                        className="w-full text-sm px-2 py-1.5 border border-gray-200 rounded focus:outline-none"
                        onChange={(e) => setPartyDropQ(e.target.value)}
                      />
                    </div>
                    <button
                      onClick={() => {
                        setPartyId("all");
                        setShowPartyDrop(false);
                        setPartyDropQ("");
                      }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 ${partyId === "all" ? "text-blue-600 font-semibold bg-blue-50" : "text-gray-700"}`}
                    >
                      All Suppliers
                    </button>
                    {filteredDropdownParties.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          setPartyId(p.id);
                          setShowPartyDrop(false);
                          setPartyDropQ("");
                        }}
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 truncate ${partyId === p.id ? "text-blue-600 font-semibold bg-blue-50" : "text-gray-700"}`}
                      >
                        {p.name}
                      </button>
                    ))}
                    {filteredDropdownParties.length === 0 && (
                      <p className="text-xs text-gray-400 text-center py-3">No suppliers found</p>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 block mb-1.5">Status</label>
              <div className="flex items-center gap-1 border border-gray-200 rounded-lg p-1 bg-gray-50/60">
                {STATUSES.map((s) => (
                  <button
                    key={s.value}
                    onClick={() => setStatus(s.value)}
                    className={`flex-1 h-8 rounded-md text-xs font-medium transition ${status === s.value ? "bg-primary text-primary-foreground font-semibold" : "text-gray-500 hover:bg-gray-100"}`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between pt-1">
              {filtersActive ? (
                <button
                  onClick={clearFilters}
                  className="text-xs text-gray-400 hover:text-gray-600 transition flex items-center gap-1"
                >
                  <X className="h-3 w-3" /> Clear all
                </button>
              ) : (
                <span />
              )}
              <button
                onClick={() => setFiltersOpen(false)}
                className="h-8 px-4 bg-primary text-primary-foreground rounded-md text-sm font-semibold hover:opacity-90 transition"
              >
                Done
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Mobile card list — a table of 10 columns doesn't fit a phone;
          this is the same data as one tappable card per bill instead. */}
      <div className="md:hidden flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <FileText className="h-10 w-10 mx-auto mb-3 text-gray-200" />
            <p className="font-medium">No bills found</p>
            <p className="text-xs mt-1">Try adjusting filters or add a new purchase</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pg.paged.map((r) => {
              const balance = Math.round((r.total - r.paid) * 100) / 100;
              const isPaid = balance <= 0;
              const isPartial = r.paid > 0 && balance > 0;
              return (
                <div
                  key={r.id}
                  onClick={() => navigate({ to: "/purchase/$id", params: { id: r.id } })}
                  className="bg-white px-4 py-3 active:bg-gray-50 flex items-center gap-3"
                >
                  {/* Status-tinted icon: green=paid, amber=partial, red=unpaid */}
                  <div
                    className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${isPaid ? "bg-emerald-50 text-emerald-600" : isPartial ? "bg-amber-50 text-amber-600" : "bg-rose-50 text-rose-600"}`}
                  >
                    <FileText className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-[13px] text-gray-800 truncate leading-tight">
                        {r.partyName}
                      </p>
                      <p className="font-bold text-[13px] text-gray-800 tabular-nums shrink-0 leading-tight">
                        {fmtMoney(r.total)}
                      </p>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-1">
                      <p className="text-[11px] text-gray-400 font-mono truncate">
                        {r.number} · {fmtDate(r.date)} · {describePayment(r, bankName)}
                      </p>
                      {balance > 0 ? (
                        <span className="text-[11px] font-semibold text-rose-600 shrink-0">
                          Due {fmtMoney(balance)}
                        </span>
                      ) : (
                        <span className="text-[11px] font-semibold text-emerald-600 shrink-0">
                          Paid
                        </span>
                      )}
                    </div>
                  </div>
                  {(editAllowed || deleteAllowed) && (
                    <div className="flex flex-col gap-0.5 shrink-0 -mr-1.5">
                      {editAllowed && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate({ to: "/purchase/edit/$id", params: { id: r.id } });
                          }}
                          className="p-1.5 rounded hover:bg-blue-50 text-gray-300 hover:text-blue-600 transition"
                          title="Edit bill"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {deleteAllowed && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(r);
                          }}
                          className="p-1.5 rounded hover:bg-rose-50 text-gray-300 hover:text-rose-500 transition"
                          title="Delete bill"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Table (desktop) */}
      <div className="hidden md:flex flex-1 min-h-0 p-6">
        <DataTable
          storageKey="purchase"
          activateOnClick
          columns={[
            {
              key: "number",
              label: "Bill #",
              render: (r) => <span className="font-mono">{r.number}</span>,
              sortValue: (r) => r.number,
            },
            {
              key: "date",
              label: "Date",
              render: (r) => <span className="whitespace-nowrap">{fmtDateShort(r.date)}</span>,
              sortValue: (r) => r.date,
            },
            {
              key: "supplier",
              label: "Supplier",
              render: (r) => <span className="max-w-[160px] truncate block">{r.partyName}</span>,
              sortValue: (r) => r.partyName,
            },
            {
              key: "items",
              label: "Items",
              align: "right",
              render: (r) => r.lineItems.length,
              sortValue: (r) => r.lineItems.length,
            },
            {
              key: "total",
              label: "Total Amount",
              align: "right",
              render: (r) => <span className="tabular-nums">{fmtMoney(r.total)}</span>,
              sortValue: (r) => r.total,
            },
            {
              key: "paid",
              label: "Paid",
              align: "right",
              render: (r) => <span className="tabular-nums">{fmtMoney(r.paid)}</span>,
              sortValue: (r) => r.paid,
            },
            {
              key: "balance",
              label: "Balance",
              align: "right",
              render: (r) => {
                const balance = Math.round((r.total - r.paid) * 100) / 100;
                return <span className="tabular-nums">{fmtMoney(Math.max(0, balance))}</span>;
              },
              sortValue: (r) => Math.max(0, Math.round((r.total - r.paid) * 100) / 100),
            },
            {
              key: "status",
              label: "Status",
              render: (r) => {
                const balance = Math.round((r.total - r.paid) * 100) / 100;
                return (
                  <StatusBadge
                    paid={balance <= 0}
                    partial={r.paid > 0 && balance > 0}
                    unpaid={r.paid === 0 && r.total > 0}
                  />
                );
              },
            },
            {
              key: "mode",
              label: "Mode",
              render: (r) => describePayment(r, bankName),
            },
            {
              key: "action",
              label: "Action",
              align: "center",
              render: (r) => (
                <span className="whitespace-nowrap">
                  {editAllowed && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate({ to: "/purchase/edit/$id", params: { id: r.id } });
                      }}
                      className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-primary-soft hover:text-primary hover:border-primary/25"
                      title="Edit bill"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {deleteAllowed && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(r);
                      }}
                      className="p-1 rounded hover:bg-rose-50 text-gray-400 hover:text-rose-500 transition"
                      title="Delete bill"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              ),
            },
          ]}
          rows={filtered}
          rowKey={(r) => r.id}
          onRowActivate={(r) => navigate({ to: "/purchase/$id", params: { id: r.id } })}
          emptyMessage="No bills found — try adjusting filters or add a new purchase"
          footer={
            <tr>
              <td colSpan={4}>Total ({filtered.length} bills)</td>
              <td className="text-right tabular-nums">{fmtMoney(totalAmount)}</td>
              <td className="text-right tabular-nums">{fmtMoney(totalPaid)}</td>
              <td className="text-right tabular-nums">{fmtMoney(totalPayable)}</td>
              <td colSpan={3} />
            </tr>
          }
        />
      </div>
      <div className="md:hidden">
        <PaginationBar
          page={pg.page}
          totalPages={pg.totalPages}
          pageSize={pg.pageSize}
          total={pg.total}
          onPage={pg.setPage}
          onPageSize={pg.setPageSize}
        />
      </div>
    </div>
  );
}

function StatusBadge({
  paid,
  partial,
  unpaid,
}: {
  paid: boolean;
  partial: boolean;
  unpaid: boolean;
}) {
  if (paid) return "Paid";
  if (partial) return "Partial";
  if (unpaid) return "Unpaid";
  return null;
}
