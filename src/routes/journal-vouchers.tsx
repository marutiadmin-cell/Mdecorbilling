import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { matchesQuery, byRelevance } from "@/lib/search";
import { useHighlightScroll } from "@/hooks/useHighlightScroll";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
import { usePagination } from "@/hooks/usePagination";
import { useAutoFocusOnDesktop } from "@/hooks/use-mobile";
import {
  JournalVoucherRepo,
  PartyRepo,
  BankRepo,
  SalesRepo,
  PurchaseRepo,
  CompanyRepo,
  nextInvoiceNumber,
} from "@/repositories";
import type { Repository } from "@/repositories/base";
import { newBatch, commitBatch, genId } from "@/repositories/base";
import { useRepoData, useRepoMemo } from "@/hooks/useRepoData";
import { useStickyState } from "@/hooks/useStickySearch";
import type {
  JournalVoucher,
  JournalLine,
  JournalAccountKind,
  JournalAllocation,
  Invoice,
} from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/Field";
import { NumInput } from "@/components/NumInput";
import { fmtMoney, fmtDate, today } from "@/lib/format";
import { Plus, Search, Pencil, Trash2, ScrollText, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { usePermissions } from "@/hooks/usePermissions";

export const Route = createFileRoute("/journal-vouchers")({ component: JournalVouchersPage });

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Keeps a line's bill-wise allocations from claiming more than the line
 *  itself now moves — called whenever its Debit/Credit amount shrinks, and
 *  again as a last defensive pass right before save. */
function clampAllocations(allocs: JournalAllocation[], limit: number): JournalAllocation[] {
  let remaining = r2(Math.max(0, limit));
  const next: JournalAllocation[] = [];
  for (const a of allocs) {
    if (remaining <= 0) break;
    const amount = Math.min(r2(a.amount), remaining);
    if (amount <= 0) continue;
    next.push({ ...a, amount });
    remaining = r2(remaining - amount);
  }
  return next;
}

const repoForDocKind = (docKind: "sale" | "purchase"): Repository<Invoice> =>
  docKind === "sale" ? SalesRepo : PurchaseRepo;

/** Undoes every bill-wise allocation a line carries — the same `paid`
 *  reversal Payment.allocations already uses on delete/edit (see
 *  src/routes/payments.tsx), guarded the same way the bank-balance
 *  reversal below guards with BankRepo.get(). */
function reverseAllocations(batch: ReturnType<typeof newBatch>, line: JournalLine) {
  for (const a of line.allocations ?? []) {
    const repo = repoForDocKind(a.docKind);
    if (repo.get(a.docId)) repo.adjustFieldBatched(batch, a.docId, "paid", -a.amount);
  }
}

/** Applies a line's bill-wise allocations, re-clamping against each bill's
 *  CURRENT outstanding amount at the moment of save — the same live-due
 *  safety re-check payments.tsx does, in case the bill was partly settled
 *  by something else since this dialog opened. */
function applyAllocations(batch: ReturnType<typeof newBatch>, line: JournalLine) {
  for (const a of line.allocations ?? []) {
    const repo = repoForDocKind(a.docKind);
    const cur = repo.get(a.docId);
    if (!cur) continue;
    const liveDue = Math.max(0, r2(cur.total - cur.paid));
    const amt = Math.min(r2(a.amount), liveDue);
    if (amt <= 0) continue;
    repo.adjustFieldBatched(batch, a.docId, "paid", amt);
  }
}

/** What a journal voucher actually moved — the sum of one side (debit and
 *  credit are always equal, so either side answers "how big was this"). */
const voucherAmount = (jv: JournalVoucher) => r2(jv.lines.reduce((s, l) => s + (l.debit || 0), 0));

interface UnifiedAccountOption {
  key: string;
  kind: JournalAccountKind;
  refId?: string;
  refName: string;
}

const KIND_LABEL: Record<JournalAccountKind, string> = {
  party: "Party",
  bank: "Bank",
  cash: "Cash",
  expense: "Expense",
  ledger: "Ledger",
};

/**
 * One type-ahead field spanning every account this app can journal
 * against — a party, a bank, cash, an expense head, or a free-text ledger —
 * matching how real accounting software (Tally, Busy) actually enters a
 * voucher: type the ledger name directly and pick from the whole chart of
 * accounts, rather than first answering "what KIND of account is this" as
 * a separate question. Typing something that matches nothing offers
 * "Add ... as a ledger account", the same on-the-fly ledger creation Tally
 * offers (Alt+C) — it becomes a free-text "ledger" kind line, same as the
 * Other A/C option this replaces.
 *
 * Modeled on ComboInput (portalled, fixed-position popup — see that file's
 * comment for why) but carries a {kind, refId, refName} choice rather than
 * a plain string, since picking a row here has to set the WHOLE line.
 */
function AccountPicker({
  value,
  options,
  onSelect,
  placeholder,
  ariaLabel,
  className,
}: {
  value: string;
  options: UnifiedAccountOption[];
  onSelect: (sel: { kind: JournalAccountKind; refId?: string; refName: string }) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  // True once the user has actually typed or arrow-key-navigated since the
  // dropdown opened — distinct from `text` just holding the pre-filled
  // value. Guards commit-on-blur/Enter from "doing" anything when nothing
  // was actually changed (see the guard in `commit` below).
  const [touched, setTouched] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  useHighlightScroll(listRef, idx, open);
  const inputRef = useRef<HTMLInputElement>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{
    position: "fixed" | "absolute";
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  // The line's own refName is the source of truth (e.g. loading an existing
  // voucher, or another field resetting it) — keep the box in sync without
  // fighting what the user is actively typing while the list is open.
  useEffect(() => {
    if (!open) setText(value);
  }, [value, open]);

  // Decide direction AND cap the popup's own height against whatever room is
  // actually there — a fixed max-height class alone still lets the popup
  // open past the bottom of the screen/dialog with nothing to scroll it
  // back into view, which is exactly what looked "not scrollable, not
  // proper" when this dialog's last row had little room below it.
  //
  // WHERE it's portalled matters just as much as its size: a Radix Dialog
  // locks page scroll while open by intercepting wheel/touch everywhere
  // EXCEPT inside its own DOM subtree. A popup portalled straight to
  // <body> — a SIBLING of the dialog, not a descendant — looks fine and
  // even takes clicks fine (pointer-events is a separate mechanism), but
  // every wheel scroll over it gets silently swallowed by that same lock.
  // Portalling inside the dialog's own node instead puts it back inside
  // the lock's recognised boundary, so scrolling works like anywhere else.
  useEffect(() => {
    if (!open) return;
    const dialogEl = inputRef.current?.closest('[role="dialog"]') as HTMLElement | null;
    setPortalTarget(dialogEl ?? document.body);
    const update = () => {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // A dialog uses a CSS transform to center itself, which makes it the
      // containing block for a `fixed`/`absolute` descendant — so a popup
      // portalled INSIDE it has to be positioned relative to the dialog's
      // own box, not the viewport, or its position math no longer matches
      // what `position: fixed` would normally mean.
      const originRect = dialogEl
        ? dialogEl.getBoundingClientRect()
        : { top: 0, left: 0, bottom: window.innerHeight };
      const margin = 8;
      const spaceBelow = window.innerHeight - r.bottom - margin;
      const spaceAbove = r.top - margin;
      const preferred = Math.min(options.length * 34 + 8, 240);
      const up = spaceBelow < Math.min(preferred, 120) && spaceAbove > spaceBelow;
      const maxHeight = Math.max(80, Math.min(preferred, up ? spaceAbove : spaceBelow));
      const position: "fixed" | "absolute" = dialogEl ? "absolute" : "fixed";
      const left = r.left - originRect.left;
      const width = Math.max(r.width, 220);
      const next = up
        ? { position, bottom: originRect.bottom - r.top + 4, left, width, maxHeight }
        : { position, top: r.bottom - originRect.top + 4, left, width, maxHeight };
      // Scrolling the list's OWN content fires this too (scroll doesn't
      // bubble, but a capture listener on window still sees it) — recompute
      // only when something actually moved, or every tick of the user's own
      // scroll re-sets identical values and the popup visibly shakes.
      setPos((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    const onScroll = (e: Event) => {
      // The popup scrolling itself never needs to reposition the popup —
      // only an ANCESTOR of the trigger input moving does.
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return;
      update();
    };
    update();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", update);
    };
  }, [open, options.length]);

  const typed = text.trim();
  const matches = typed
    ? options.filter((o) => matchesQuery(typed, o.refName)).sort(byRelevance(typed, (o) => o.refName))
    : options;
  const exact = !!typed && options.some((o) => o.refName.toLowerCase() === typed.toLowerCase());
  const canCreate = !!typed && !exact;
  const rows: (UnifiedAccountOption | null)[] = canCreate ? [...matches, null] : matches;

  const commit = (opt: UnifiedAccountOption | null) => {
    // Nothing was actually typed or arrow-navigated — close without an
    // onSelect call. This matters beyond just avoiding a no-op: the options
    // list excludes things like an archived party (so a NEW line can't pick
    // one), but an EXISTING line can still legitimately show one as its
    // current value. Without this guard, simply tabbing through that field
    // would find no match for "archived party's name" in the searchable
    // list and silently convert the line to a free-text ledger entry,
    // severing it from the real party it was tracking. Checking `touched`
    // rather than comparing text also means a deliberate arrow-key-only
    // pick (no typing at all) still commits correctly.
    if (!touched) {
      setOpen(false);
      return;
    }
    if (opt) {
      onSelect({ kind: opt.kind, refId: opt.refId, refName: opt.refName });
      setText(opt.refName);
    } else if (typed) {
      onSelect({ kind: "ledger", refId: typed, refName: typed });
      setText(typed);
    }
    setOpen(false);
  };

  return (
    <>
      <input
        ref={inputRef}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setIdx(0);
          setTouched(true);
        }}
        onFocus={(e) => {
          setOpen(true);
          setTouched(false);
          e.currentTarget.select();
        }}
        onBlur={() => {
          // Tab is the natural way to move to Debit after typing a name —
          // Enter is NOT the only way to leave this field. Without this, a
          // typed account sat in the box looking chosen while the line's
          // actual kind/refId silently stayed whatever they were before.
          setTimeout(() => {
            if (touched) commit(rows[idx] ?? null);
            else setText(value);
            setOpen(false);
          }, 150);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setTouched(true);
            setIdx((i) => Math.min(rows.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setTouched(true);
            setIdx((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && open && rows.length) {
            e.preventDefault();
            commit(rows[idx] ?? null);
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className={className}
      />
      {open &&
        pos &&
        portalTarget &&
        rows.length > 0 &&
        createPortal(
          <div
            role="listbox"
            aria-label={ariaLabel}
            style={{
              position: pos.position,
              top: pos.top,
              bottom: pos.bottom,
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
              overflowY: "auto",
              pointerEvents: "auto",
            }}
            ref={listRef}
            className="z-50 border rounded-md bg-popover shadow-elevated py-1"
          >
            {rows.map((opt, i) => (
              <div
                key={opt?.key ?? "__create__"}
                data-opt={i}
                role="option"
                aria-selected={i === idx}
                onMouseEnter={() => setIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(opt);
                }}
                className={`px-2.5 py-1.5 text-[13px] cursor-pointer flex items-center justify-between gap-2 ${
                  i === idx ? "bg-accent" : "hover:bg-accent"
                } ${opt === null ? "text-primary font-medium border-t" : ""}`}
              >
                {opt === null ? (
                  <span className="flex items-center gap-1.5">
                    <Plus className="h-3.5 w-3.5 shrink-0" />
                    Add &ldquo;{typed}&rdquo; as a ledger account
                  </span>
                ) : (
                  <>
                    <span className="truncate">{opt.refName}</span>
                    <span className="text-[10px] text-muted-foreground uppercase shrink-0">
                      {KIND_LABEL[opt.kind]}
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>,
          portalTarget,
        )}
    </>
  );
}

function JournalVouchersPage() {
  const searchRef = useRef<HTMLInputElement>(null);
  useAutoFocusOnDesktop(searchRef);
  const { isOwner, canEdit, canDelete } = usePermissions();
  const editAllowed = isOwner || canEdit("cashBank");
  const deleteAllowed = isOwner || canDelete("cashBank");
  const [rows, setRows] = useState<JournalVoucher[]>([]);
  const [q, setQ] = useStickyState("journal-vouchers.search", "");
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<JournalVoucher | null>(null);

  const refresh = () =>
    setRows(JournalVoucherRepo.all().sort((a, b) => b.date.localeCompare(a.date)));
  const _repoV = useRepoData();
  useEffect(refresh, [_repoV]);

  const filtered = rows.filter((r) => {
    const s = q.toLowerCase();
    return matchesQuery(s, r.number, r.narration);
  });
  const pg = usePagination(filtered, "journal-vouchers");
  const grandTotal = filtered.reduce((s, r) => s + voucherAmount(r), 0);

  /**
   * Delete a voucher, reversing whatever it moved on STORED fields elsewhere.
   *
   * Party/Cash/Expense/Ledger "balances" are never stored directly — they are
   * always replayed fresh from every JournalVoucherRepo record alongside
   * every other document (see ledger.ts), so deleting the document itself is
   * the whole reversal for those kinds. Two things ARE materialised fields on
   * another document, exactly like every other document that touches them,
   * and need an explicit reversing write here: a Bank account's `balance`,
   * and a bill-wise-adjusted Sale/Purchase's `paid`.
   */
  const deleteVoucher = (jv: JournalVoucher) => {
    if (!deleteAllowed) {
      toast.error("You don't have permission to delete journal vouchers");
      return;
    }
    if (!confirm(`Delete journal voucher ${jv.number}? This cannot be undone.`)) return;
    const live = JournalVoucherRepo.get(jv.id);
    if (!live) {
      toast.info(`${jv.number} was already deleted`);
      refresh();
      return;
    }
    const batch = newBatch();
    for (const l of live.lines) {
      if (l.kind === "bank" && l.refId && BankRepo.get(l.refId)) {
        BankRepo.adjustFieldBatched(batch, l.refId, "balance", -(l.debit - l.credit));
      }
      reverseAllocations(batch, l);
    }
    JournalVoucherRepo.removeBatched(batch, live.id);
    commitBatch(batch, "delete journal voucher").then((ok) => {
      refresh();
      if (!ok) {
        toast.error("Could not delete — reload and check before trying again");
        return;
      }
      toast.success(`${jv.number} deleted`);
    });
  };

  const columns: Column<JournalVoucher>[] = [
    {
      key: "number",
      label: "JV #",
      render: (r) => <span className="font-mono">{r.number}</span>,
      sortValue: (r) => r.number,
    },
    {
      key: "date",
      label: "Date",
      width: "110px",
      render: (r) => fmtDate(r.date),
      sortValue: (r) => r.date,
    },
    {
      key: "narration",
      label: "Narration",
      render: (r) => <span className="truncate block max-w-[360px]">{r.narration}</span>,
    },
    {
      key: "lines",
      label: "Lines",
      align: "right",
      width: "70px",
      render: (r) => r.lines.length,
    },
    {
      key: "amount",
      label: "Amount",
      align: "right",
      width: "130px",
      render: (r) => fmtMoney(voucherAmount(r)),
      sortValue: (r) => voucherAmount(r),
    },
    {
      key: "actions",
      label: "Action",
      width: "90px",
      align: "center",
      render: (r) => (
        <span className="inline-flex items-center justify-center gap-0.5">
          {editAllowed && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEdit(r);
                setOpen(true);
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-primary-soft hover:text-primary hover:border-primary/25"
              title="Edit"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {deleteAllowed && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                deleteVoucher(r);
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-transparent text-gray-400 transition hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200"
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Journal Vouchers"
        subtitle={`${rows.length} vouchers · ${fmtMoney(grandTotal)} total movement`}
        icon={<ScrollText className="h-5 w-5" />}
        actions={
          <>
            <div className="relative w-full sm:w-44 lg:w-56">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                ref={searchRef}
                placeholder="Search number or narration..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-full h-8 pl-8 pr-3 border border-gray-200 rounded-md text-base md:text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
              />
            </div>
            {editAllowed && (
              <Button
                size="sm"
                onClick={() => {
                  setEdit(null);
                  setOpen(true);
                }}
                className="w-full sm:w-auto"
              >
                <Plus className="h-3.5 w-3.5" /> New Journal Voucher
              </Button>
            )}
          </>
        }
      />

      {/* Mobile card list */}
      <div className="md:hidden flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <ScrollText className="h-10 w-10 mx-auto mb-3 text-gray-200" />
            <p className="font-medium">No journal vouchers yet</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {pg.paged.map((r) => (
              <div
                key={r.id}
                onClick={() => editAllowed && (setEdit(r), setOpen(true))}
                className="bg-white p-4 active:bg-gray-50"
              >
                <div className="flex items-start justify-between gap-3 mb-1">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-800 font-mono text-[13px]">{r.number}</p>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">{r.narration}</p>
                  </div>
                  <p className="font-bold text-gray-800 tabular-nums shrink-0">
                    {fmtMoney(voucherAmount(r))}
                  </p>
                </div>
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>
                    {fmtDate(r.date)} · {r.lines.length} lines
                  </span>
                  {deleteAllowed && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteVoucher(r);
                      }}
                      className="p-1.5 rounded hover:bg-rose-50 text-gray-400 hover:text-rose-600 transition"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="hidden md:flex flex-1 min-h-0 p-6">
        <DataTable
          storageKey="journal-vouchers"
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.id}
          footer={
            <tr>
              <td colSpan={4}>Total ({filtered.length} vouchers)</td>
              <td className="text-right tabular-nums">{fmtMoney(grandTotal)}</td>
              <td />
            </tr>
          }
        />
      </div>

      <JournalVoucherDialog open={open} onOpenChange={setOpen} voucher={edit} onSaved={refresh} />
    </div>
  );
}

/** A line being edited — same shape as JournalLine (its `id` already doubles
 *  as the React key, generated client-side whether or not this ever saves). */
type DraftLine = JournalLine;

function blankLine(): DraftLine {
  return {
    id: genId(),
    kind: "party",
    refId: undefined,
    refName: "",
    debit: 0,
    credit: 0,
    description: "",
  };
}

function JournalVoucherDialog({
  open,
  onOpenChange,
  voucher,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  voucher: JournalVoucher | null;
  onSaved: () => void;
}) {
  const [date, setDate] = useState(today());
  const [narration, setNarration] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const narrationRef = useRef<HTMLInputElement>(null);

  const parties = useRepoMemo(() => PartyRepo.all().filter((p) => !p.archived));
  const banks = useRepoMemo(() => BankRepo.all());
  const sales = useRepoMemo(() => SalesRepo.all());
  const purchases = useRepoMemo(() => PurchaseRepo.all());
  const expenseCategories = CompanyRepo.get().expenseCategories ?? [];
  const ledgerAccounts = CompanyRepo.get().journalLedgerAccounts ?? [];

  // ONE flat list spanning every kind of account this app can journal
  // against — a party, a bank, cash, an expense head, or a free-text ledger
  // — so the Particulars field below can search across all of them at
  // once, the way a real chart-of-accounts picker does, instead of forcing
  // "what kind is this" as a separate question before "which one".
  const unifiedAccounts: UnifiedAccountOption[] = [
    { key: "cash", kind: "cash", refId: undefined, refName: "Cash" },
    ...parties.map((p) => ({ key: `party:${p.id}`, kind: "party" as const, refId: p.id, refName: p.name })),
    ...banks.map((b) => ({ key: `bank:${b.id}`, kind: "bank" as const, refId: b.id, refName: b.name })),
    ...expenseCategories.map((c) => ({
      key: `expense:${c}`,
      kind: "expense" as const,
      refId: c,
      refName: c,
    })),
    ...ledgerAccounts.map((l) => ({
      key: `ledger:${l}`,
      kind: "ledger" as const,
      refId: l,
      refName: l,
    })),
  ];

  useEffect(() => {
    if (!open) return;
    if (voucher) {
      setDate(voucher.date);
      setNarration(voucher.narration);
      setLines(voucher.lines.map((l) => ({ ...l })));
    } else {
      setDate(today());
      setNarration("");
      setLines([blankLine(), blankLine()]);
    }
    setSaving(false);
    savingRef.current = false;
    setTimeout(() => narrationRef.current?.focus(), 50);
  }, [open, voucher]);

  const totalDebit = r2(lines.reduce((s, l) => s + (l.debit || 0), 0));
  const totalCredit = r2(lines.reduce((s, l) => s + (l.credit || 0), 0));
  const balanced = Math.abs(totalDebit - totalCredit) < 0.005 && totalDebit > 0;

  const updateLine = (id: string, patch: Partial<DraftLine>) => {
    setLines((cur) => cur.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };

  const addLine = () => setLines((cur) => [...cur, blankLine()]);
  const removeLine = (id: string) => setLines((cur) => cur.filter((l) => l.id !== id));

  const save = () => {
    if (savingRef.current) return;
    const narr = narration.trim();
    if (!narr) {
      toast.error("Narration is required — say what this entry is for");
      narrationRef.current?.focus();
      return;
    }
    const real = lines.filter((l) => (l.debit || 0) > 0 || (l.credit || 0) > 0);
    if (real.length < 2) {
      toast.error("Add at least two lines");
      return;
    }
    for (const l of real) {
      if ((l.debit || 0) > 0 && (l.credit || 0) > 0) {
        toast.error(`A line can be Debit OR Credit, not both — check "${l.refName || "a line"}"`);
        return;
      }
      // Every kind resolves to a non-empty refId once properly picked
      // (party/bank id, or the expense/ledger name itself) — "cash" is the
      // one kind with nothing further to choose.
      if (l.kind !== "cash" && !l.refId?.trim()) {
        toast.error("Pick an account for every line — type a name and choose from the list");
        return;
      }
    }
    if (!balanced) {
      toast.error(
        `Debit and Credit must be equal — currently ${fmtMoney(totalDebit)} Dr vs ${fmtMoney(totalCredit)} Cr`,
      );
      return;
    }

    savingRef.current = true;
    setSaving(true);

    const batch = newBatch();

    const finalLines: JournalLine[] = real.map((l) => {
      const debit = r2(l.debit || 0);
      const credit = r2(l.credit || 0);
      const allocations = clampAllocations(l.allocations ?? [], Math.max(debit, credit));
      return {
        id: l.id,
        kind: l.kind,
        refId: l.refId,
        refName: l.refName,
        debit,
        credit,
        description: l.description?.trim() || undefined,
        allocations: allocations.length ? allocations : undefined,
      };
    });

    // Editing: reverse whatever the OLD version of this voucher moved on a
    // stored bank balance or a bill it adjusted, before applying what the
    // NEW version moves — same "reverse then reapply" rule every other edit
    // path in this app follows, so an edit can never double-apply or
    // half-apply its effect.
    if (voucher) {
      for (const l of voucher.lines) {
        if (l.kind === "bank" && l.refId && BankRepo.get(l.refId)) {
          BankRepo.adjustFieldBatched(batch, l.refId, "balance", -(l.debit - l.credit));
        }
        reverseAllocations(batch, l);
      }
    }
    for (const l of finalLines) {
      if (l.kind === "bank" && l.refId && BankRepo.get(l.refId)) {
        BankRepo.adjustFieldBatched(batch, l.refId, "balance", l.debit - l.credit);
      }
      applyAllocations(batch, l);
    }

    if (voucher) {
      JournalVoucherRepo.updateBatched(batch, voucher.id, { date, narration: narr, lines: finalLines });
    } else {
      const company = CompanyRepo.get();
      JournalVoucherRepo.addBatched(batch, {
        id: genId(),
        number: nextInvoiceNumber(company.journalVoucherPrefix || "JV-", JournalVoucherRepo.all()),
        date,
        narration: narr,
        lines: finalLines,
      });
    }

    commitBatch(batch, "save journal voucher").then((ok) => {
      savingRef.current = false;
      setSaving(false);
      if (!ok) {
        toast.error("Could not save — reload and check before trying again");
        return;
      }
      // Best-effort, outside the batch — this is only a suggestion list for
      // next time, not financial data, so it never blocks the real save.
      const typedLedgerNames = real
        .filter((l) => l.kind === "ledger")
        .map((l) => l.refName.trim())
        .filter(Boolean);
      if (typedLedgerNames.length) {
        const company = CompanyRepo.get();
        const existing = company.journalLedgerAccounts ?? [];
        const existingLower = new Set(existing.map((x) => x.toLowerCase()));
        const fresh = typedLedgerNames.filter((n) => !existingLower.has(n.toLowerCase()));
        if (fresh.length) {
          CompanyRepo.save({
            ...company,
            journalLedgerAccounts: [...existing, ...fresh].slice(-30),
          });
        }
      }
      toast.success(voucher ? "Journal voucher updated" : "Journal voucher saved");
      onSaved();
      onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle>{voucher ? `Edit ${voucher.number}` : "New Journal Voucher"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <Field
              ref={narrationRef}
              label="Narration *"
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
              placeholder="What this entry is for"
            />
          </div>

          <div className="border rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-[13px] min-w-[780px]">
                <thead className="text-[11px] text-muted-foreground uppercase tracking-wider bg-muted/40">
                  <tr>
                    <th className="text-left px-3 py-2">Particulars</th>
                    <th className="text-right px-2 py-2 w-28">Debit</th>
                    <th className="text-right px-2 py-2 w-28">Credit</th>
                    <th className="text-left px-2 py-2 w-40">Description</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <Fragment key={l.id}>
                    <tr className="border-t">
                      <td className="px-2 py-1.5">
                        <AccountPicker
                          value={l.refName}
                          options={unifiedAccounts}
                          onSelect={(sel) => {
                            // An ACTUAL account change invalidates whatever
                            // bill-wise adjustment was picked against the OLD
                            // account's invoices. But onSelect now also
                            // fires on blur/Tab-away (see AccountPicker) even
                            // when nothing changed — e.g. tabbing through an
                            // already-filled line — so only reset when the
                            // account really is different, or that keyboard
                            // navigation alone would silently wipe a
                            // correctly-entered bill-wise adjustment.
                            const changed = sel.kind !== l.kind || sel.refId !== l.refId;
                            updateLine(l.id, { ...sel, allocations: changed ? [] : l.allocations });
                          }}
                          placeholder="Type a party, bank, cash, expense or account name..."
                          ariaLabel="Account"
                          className="h-8 w-full px-1.5 border rounded bg-background focus:border-primary outline-none"
                        />
                      </td>
                      <td className="px-1 py-1.5">
                        <NumInput
                          value={l.debit}
                          onValue={(n) => {
                            const credit = n > 0 ? 0 : l.credit;
                            updateLine(l.id, {
                              debit: n,
                              credit,
                              allocations: clampAllocations(l.allocations ?? [], Math.max(n, credit)),
                            });
                          }}
                          className="w-full h-8 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                        />
                      </td>
                      <td className="px-1 py-1.5">
                        <NumInput
                          value={l.credit}
                          onValue={(n) => {
                            const debit = n > 0 ? 0 : l.debit;
                            updateLine(l.id, {
                              credit: n,
                              debit,
                              allocations: clampAllocations(l.allocations ?? [], Math.max(n, debit)),
                            });
                          }}
                          className="w-full h-8 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
                        />
                      </td>
                      <td className="px-1 py-1.5">
                        <input
                          type="text"
                          value={l.description ?? ""}
                          onChange={(e) => updateLine(l.id, { description: e.target.value })}
                          placeholder="Optional note for this line"
                          className="w-full h-8 px-1.5 border rounded bg-background focus:border-primary outline-none text-[13px]"
                        />
                      </td>
                      <td className="px-1 py-1.5 text-center">
                        {lines.length > 2 && (
                          <button
                            type="button"
                            onClick={() => removeLine(l.id)}
                            className="text-destructive p-1 hover:bg-destructive/10 rounded"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                    {l.kind === "party" && l.refId && (
                      <tr className="border-t bg-muted/10">
                        <td colSpan={5} className="px-3 py-2">
                          <JournalBillWiseAdjustment
                            line={l}
                            sales={sales}
                            purchases={purchases}
                            onChange={(allocations) => updateLine(l.id, { allocations })}
                          />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
                <tfoot className="border-t-2 bg-muted/30 font-semibold">
                  <tr>
                    <td className="px-3 py-2">Total</td>
                    <td className="text-right px-2 py-2 tabular-nums">{fmtMoney(totalDebit)}</td>
                    <td className="text-right px-2 py-2 tabular-nums">{fmtMoney(totalCredit)}</td>
                    <td />
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="px-3 py-2 border-t bg-card">
              <Button type="button" variant="outline" size="sm" onClick={addLine}>
                <Plus className="h-3.5 w-3.5" /> Add Line
              </Button>
            </div>
          </div>

          {!balanced && (totalDebit > 0 || totalCredit > 0) && (
            <p className="text-[12px] text-destructive">
              Debit and Credit don't match — difference of{" "}
              {fmtMoney(Math.abs(totalDebit - totalCredit))}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={save} disabled={saving || !balanced}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Ties part of a party line to specific outstanding Sales/Purchase bills —
 * exactly what the client's reference accounting software calls "Sales
 * Transaction Adjustment" / "Purchase Transaction Adjustment". Shown for
 * both sides at once (a party can be both a customer and a supplier), and
 * entirely optional: leaving every amount at 0 just moves the party's
 * overall balance, the same as a JV with no bill-wise detail always has.
 */
function JournalBillWiseAdjustment({
  line,
  sales,
  purchases,
  onChange,
}: {
  line: DraftLine;
  sales: Invoice[];
  purchases: Invoice[];
  onChange: (allocations: JournalAllocation[]) => void;
}) {
  const lineAmount = r2(Math.max(line.debit || 0, line.credit || 0));
  const allocations = line.allocations ?? [];
  const totalAllocated = r2(allocations.reduce((s, a) => s + a.amount, 0));

  const rowsFor = (docs: Invoice[], docKind: "sale" | "purchase") => {
    const allocOf = new Map(
      allocations.filter((a) => a.docKind === docKind).map((a) => [a.docId, a.amount]),
    );
    return docs
      .filter(
        (inv) =>
          inv.partyId === line.refId && (r2(inv.total - inv.paid) > 0.01 || allocOf.has(inv.id)),
      )
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((inv) => ({
        invoice: inv,
        due: r2(inv.total - inv.paid + (allocOf.get(inv.id) ?? 0)),
        applied: allocOf.get(inv.id) ?? 0,
      }));
  };

  const setAmount = (
    docId: string,
    docKind: "sale" | "purchase",
    number: string,
    due: number,
    amount: number,
  ) => {
    const others = allocations.filter((a) => a.docId !== docId);
    const othersTotal = r2(others.reduce((s, a) => s + a.amount, 0));
    // Can't settle more of a bill than it owes, or more in total than this
    // line itself is moving.
    const capped = Math.max(0, Math.min(r2(amount), due, r2(lineAmount - othersTotal)));
    onChange(capped > 0 ? [...others, { docId, docKind, number, amount: capped }] : others);
  };

  const salesRows = rowsFor(sales, "sale");
  const purchaseRows = rowsFor(purchases, "purchase");

  if (!salesRows.length && !purchaseRows.length) {
    return (
      <p className="text-[11px] text-muted-foreground">
        No outstanding sales or purchase bills for this party to adjust against — this line will
        only move their overall balance.
      </p>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <BillPanel
          title="Sales Transaction Adjustment"
          hint="What this party owes us"
          rows={salesRows}
          docKind="sale"
          onApply={setAmount}
        />
        <BillPanel
          title="Purchase Transaction Adjustment"
          hint="What we owe this party"
          rows={purchaseRows}
          docKind="purchase"
          onApply={setAmount}
        />
      </div>
      {totalAllocated > 0 && (
        <p className="text-[11px] text-muted-foreground mt-2">
          {fmtMoney(totalAllocated)} of {fmtMoney(lineAmount)} tied to specific bills above
          {totalAllocated < lineAmount &&
            ` — the remaining ${fmtMoney(r2(lineAmount - totalAllocated))} only moves the party's overall balance`}
          .
        </p>
      )}
    </div>
  );
}

function BillPanel({
  title,
  hint,
  rows,
  docKind,
  onApply,
}: {
  title: string;
  hint: string;
  rows: { invoice: Invoice; due: number; applied: number }[];
  docKind: "sale" | "purchase";
  onApply: (docId: string, docKind: "sale" | "purchase", number: string, due: number, amount: number) => void;
}) {
  if (!rows.length) return null;
  return (
    <div className="border rounded-md overflow-hidden bg-background">
      <div className="px-2.5 py-1.5 bg-muted/40">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
        <p className="text-[10px] text-muted-foreground">{hint}</p>
      </div>
      <div className="max-h-40 overflow-y-auto divide-y">
        {rows.map((r) => (
          <div key={r.invoice.id} className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
            <div className="flex-1 min-w-0">
              <p className="font-mono truncate">{r.invoice.number}</p>
              <p className="text-muted-foreground text-[11px]">
                {fmtDate(r.invoice.date)} · Due {fmtMoney(r.due)}
              </p>
            </div>
            <NumInput
              value={r.applied}
              onValue={(n) => onApply(r.invoice.id, docKind, r.invoice.number, r.due, n)}
              className="w-24 h-7 px-1.5 text-right border rounded bg-background focus:border-primary outline-none"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
