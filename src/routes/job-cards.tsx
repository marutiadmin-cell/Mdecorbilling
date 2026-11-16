/**
 * Job Cards — what the workshop is making, by stage.
 *
 * One card per measured window on an order (made from a quotation / proforma
 * with "Create job cards"), or made here on its own. A card moves through
 * Settings → Manufacturing's stages; reaching the "made" stage records the
 * production run (materials out, slats cut, the blind into stock) — done on
 * the card's own page, where the cutting plan is shown before saving.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
import {
  JobCardRepo,
  PartyRepo,
  ItemRepo,
  BomRepo,
  CompanyRepo,
  nextInvoiceNumber,
} from "@/repositories";
import { useRepoData, useRepoMemo } from "@/hooks/useRepoData";
import { useStickyState } from "@/hooks/useStickySearch";
import { usePermissions } from "@/hooks/usePermissions";
import { matchesQuery } from "@/lib/search";
import { fmtDateShort, today } from "@/lib/format";
import { mtmOf } from "@/lib/mtm";
import { cardSize } from "@/lib/jobCards";
import { madeQty } from "@/lib/sizing";
import { LENGTH_LABEL, type LengthUnit } from "@/lib/units";
import type { JobCard } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NumInput } from "@/components/NumInput";
import { ComboInput } from "@/components/ComboInput";
import { ItemPicker } from "@/components/ItemPicker";
import { ClipboardList, Plus, Search, X } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/job-cards")({ component: JobCardsPage });

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Where a card's stage change has to go: making it (or undoing that)
 *  happens on the card's page, everything else right here. */
export function stageMove(card: JobCard, target: string) {
  const m = mtmOf(CompanyRepo.get());
  const doneAt = m.jobStages.indexOf(m.completeStage);
  const to = m.jobStages.indexOf(target);
  if (!card.productionId && to >= doneAt) return "make" as const;
  if (card.productionId && to < doneAt) return "undo" as const;
  return "plain" as const;
}

export function setStage(card: JobCard, stage: string) {
  JobCardRepo.update(card.id, {
    stage,
    history: [...(card.history ?? []), { stage, at: new Date().toISOString() }],
  });
}

function JobCardsPage() {
  useRepoData();
  const navigate = useNavigate();
  const { isOwner, canEdit } = usePermissions();
  const editAllowed = isOwner || canEdit("masterData");
  const m = mtmOf(CompanyRepo.get());
  const [q, setQ] = useStickyState("jobcards.search", "");
  const [stage, setStageFilter] = useStickyState("jobcards.stage", "open");
  const [open, setOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const now = today();
  const doneIdx = m.jobStages.indexOf(m.completeStage);

  const rows = useRepoMemo(
    () =>
      JobCardRepo.all()
        .filter((c) => {
          const i = m.jobStages.indexOf(c.stage);
          if (stage === "open") return i < doneIdx || i === -1;
          if (stage === "due") return i < doneIdx && !!c.dueDate && c.dueDate <= now;
          if (stage === "all") return true;
          return c.stage === stage;
        })
        .filter(
          (c) =>
            !q.trim() ||
            matchesQuery(
              q,
              `${c.number} ${c.partyName} ${c.partyPhone ?? ""} ${c.finishedItemName} ${c.type ?? ""} ${c.serial ?? ""} ${c.sourceNumber ?? ""}`,
            ),
        )
        .sort(
          (a, b) =>
            (a.dueDate ?? "9").localeCompare(b.dueDate ?? "9") || b.number.localeCompare(a.number),
        ),
    [q, stage],
  );

  const changeStage = (c: JobCard, target: string) => {
    const move = stageMove(c, target);
    if (move === "plain") return setStage(c, target);
    // Making it (or undoing that) happens on its page, with the plan shown.
    navigate({ to: "/job-cards/$id", params: { id: c.id }, search: { go: target } as never });
  };

  const stageSelect = (c: JobCard) => (
    <select
      value={c.stage}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => changeStage(c, e.target.value)}
      disabled={!editAllowed}
      aria-label={`Stage of ${c.number}`}
      className={`h-7 px-1.5 border rounded text-[12px] ${c.productionId ? "bg-emerald-50 border-emerald-300" : "bg-background"}`}
    >
      {m.jobStages.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );

  const columns: Column<JobCard>[] = [
    {
      key: "number",
      label: "Job",
      width: "100px",
      render: (c) => <span className="font-semibold">{c.number}</span>,
      sortValue: (c) => c.number,
    },
    {
      key: "date",
      label: "Date",
      width: "90px",
      render: (c) => fmtDateShort(c.date),
      sortValue: (c) => c.date,
    },
    { key: "party", label: "Customer", render: (c) => c.partyName, sortValue: (c) => c.partyName },
    {
      key: "what",
      label: "Item · type",
      render: (c) => (
        <span className="truncate">
          {c.finishedItemName}
          {c.type ? <span className="text-muted-foreground"> · {c.type}</span> : null}
        </span>
      ),
    },
    {
      key: "size",
      label: "Size",
      width: "140px",
      render: (c) => `${cardSize(c)}${c.pieces > 1 ? ` × ${c.pieces}` : ""}`,
    },
    {
      key: "stage",
      label: "Stage",
      width: "130px",
      render: (c) => stageSelect(c),
      sortValue: (c) => m.jobStages.indexOf(c.stage),
    },
    {
      key: "due",
      label: "Due",
      width: "90px",
      render: (c) =>
        c.dueDate ? (
          <span className={c.dueDate < now && !c.productionId ? "text-rose-600 font-medium" : ""}>
            {fmtDateShort(c.dueDate)}
          </span>
        ) : (
          "—"
        ),
      sortValue: (c) => c.dueDate ?? "",
    },
    { key: "src", label: "Order", width: "100px", render: (c) => c.sourceNumber ?? "—" },
  ];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Job Cards"
        subtitle="What the workshop is making"
        icon={<ClipboardList className="h-5 w-5" />}
        actions={
          editAllowed && (
            <Button size="sm" onClick={() => setOpen(true)} className="w-full sm:w-auto">
              <Plus className="h-3.5 w-3.5" /> New job card
            </Button>
          )
        }
      />
      <div className="px-4 sm:px-6 pt-3 flex flex-col gap-2">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Stage">
          {[
            ["open", "Not made yet"],
            ["due", "Due / overdue"],
            ...m.jobStages.map((s) => [s, s]),
            ["all", "All"],
          ].map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={stage === k}
              onClick={() => setStageFilter(k)}
              className={`h-7 px-2.5 rounded-full text-[12px] font-semibold border ${stage === k ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-accent"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative max-w-sm">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search job, customer, serial…"
            className="h-9 w-full pl-8 pr-8 border rounded-md bg-background text-[16px] sm:text-[13px]"
            aria-label="Search job cards"
          />
          {q && (
            <button
              onClick={() => setQ("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Phone: cards */}
      <div className="md:hidden flex-1 overflow-auto mt-2">
        {rows.length === 0 ? (
          <EmptyCards />
        ) : (
          <div className="divide-y divide-gray-100">
            {rows.map((c) => (
              <div
                key={c.id}
                className="bg-white px-4 py-3"
                onClick={() => navigate({ to: "/job-cards/$id", params: { id: c.id } })}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-[13px]">
                    {c.number} · {c.partyName}
                  </p>
                  {stageSelect(c)}
                </div>
                <p className="text-[11.5px] text-gray-500 mt-1 truncate">
                  {c.type ?? c.finishedItemName} · {cardSize(c)}
                  {c.dueDate ? ` · due ${fmtDateShort(c.dueDate)}` : ""}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="hidden md:flex flex-1 min-h-0 p-6 pt-3">
        {rows.length === 0 ? (
          <div className="flex-1">
            <EmptyCards />
          </div>
        ) : (
          <DataTable
            storageKey="job-cards"
            columns={columns}
            rows={rows}
            rowKey={(c) => c.id}
            activateOnClick
            onRowActivate={(c) => navigate({ to: "/job-cards/$id", params: { id: c.id } })}
          />
        )}
      </div>
      <JobCardDialog
        open={open}
        onOpenChange={setOpen}
        card={null}
        onSaved={(id) => navigate({ to: "/job-cards/$id", params: { id } })}
      />
    </div>
  );
}

function EmptyCards() {
  return (
    <div className="text-center py-16 text-gray-400">
      <ClipboardList className="h-10 w-10 mx-auto mb-3 text-gray-200" />
      <p className="font-medium">No job cards here</p>
      <p className="text-xs mt-1">
        Open a quotation or proforma with measured windows and press "Create job cards", or make one
        here.
      </p>
    </div>
  );
}

/** Make or change a job card by hand. */
export function JobCardDialog({
  open,
  onOpenChange,
  card,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  card: JobCard | null;
  onSaved?: (id: string) => void;
}) {
  const m = mtmOf(CompanyRepo.get());
  const parties = useRepoMemo(() =>
    PartyRepo.all().filter((p) => !p.archived && p.type !== "supplier"),
  );
  const sizedItems = useRepoMemo(() => {
    const made = new Set(
      BomRepo.all()
        .filter((b) => b.sizing && !b.archived)
        .map((b) => b.finishedItemId),
    );
    return ItemRepo.all().filter((i) => made.has(i.id) || i.kind === "finished");
  });
  const blank = (): Partial<JobCard> => ({
    date: today(),
    stage: m.jobStages[0],
    partyName: "",
    finishedItemName: "",
    size: { w: 0, h: 0, unit: m.sizeUnit },
    pieces: 1,
    type: m.productTypes[0],
  });
  const [f, setF] = useState<Partial<JobCard>>(blank);
  useEffect(() => {
    if (open) setF(card ? { ...card } : blank());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, card]);
  const set = (patch: Partial<JobCard>) => setF((x) => ({ ...x, ...patch }));
  const cls =
    "h-9 w-full px-2 border rounded bg-background text-[16px] sm:text-[13px] outline-none focus:border-primary";

  const save = () => {
    const size = f.size ?? { w: 0, h: 0, unit: m.sizeUnit };
    if (!f.partyName?.trim()) return void toast.error("Enter the customer");
    if (!f.finishedItemId) return void toast.error("Choose what is being made");
    if (!(size.w > 0 && size.h > 0)) return void toast.error("Enter the width and height");
    const bom = BomRepo.all().find(
      (b) => b.finishedItemId === f.finishedItemId && b.sizing && !b.archived,
    );
    const item = ItemRepo.get(f.finishedItemId);
    const pieces = Math.max(1, Math.floor(f.pieces || 1));
    const qty = bom ? madeQty(bom, size, pieces, item?.unit, m.minSqft) : pieces;
    const party = parties.find(
      (p) => p.name.trim().toLowerCase() === f.partyName!.trim().toLowerCase(),
    );
    const record = {
      date: f.date || today(),
      dueDate: f.dueDate || undefined,
      stage: f.stage || m.jobStages[0],
      history: f.history ?? [{ stage: f.stage || m.jobStages[0], at: new Date().toISOString() }],
      assignedTo: f.assignedTo?.trim() || undefined,
      partyId: party?.id ?? f.partyId,
      partyName: f.partyName.trim(),
      partyPhone: f.partyPhone?.trim() || party?.phone || undefined,
      partyAddress:
        f.partyAddress?.trim() ||
        [party?.address, party?.city].filter(Boolean).join(", ") ||
        undefined,
      finishedItemId: f.finishedItemId,
      finishedItemName: item?.name ?? f.finishedItemName ?? "",
      bomId: bom?.id,
      size,
      pieces,
      qty: card?.sourceId ? (card.qty ?? qty) : r2(qty),
      type: f.type?.trim() || undefined,
      operateSide: f.operateSide || undefined,
      serial: f.serial?.trim() || undefined,
      note: f.note?.trim() || undefined,
    };
    if (card) {
      JobCardRepo.update(card.id, record);
      toast.success(`${card.number} updated`);
      onSaved?.(card.id);
    } else {
      const made = JobCardRepo.add({
        ...record,
        number: nextInvoiceNumber(m.jobPrefix, JobCardRepo.all()),
      } as never);
      toast.success(`${(made as JobCard).number} created`);
      onSaved?.((made as JobCard).id);
    }
    onOpenChange(false);
  };

  const size = f.size ?? { w: 0, h: 0, unit: m.sizeUnit };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{card ? `Edit job card ${card.number}` : "New job card"}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[12px]">
          <label className="flex flex-col gap-1 col-span-2">
            <span className="text-muted-foreground font-medium">Customer *</span>
            <ComboInput
              value={f.partyName ?? ""}
              onValue={(v) => {
                const p = parties.find((x) => x.name === v);
                set({
                  partyName: v,
                  partyPhone: p?.phone ?? f.partyPhone,
                  partyAddress: p ? [p.address, p.city].filter(Boolean).join(", ") : f.partyAddress,
                });
              }}
              options={parties.map((p) => p.name)}
              ariaLabel="Job customer"
              className={cls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground font-medium">Mobile</span>
            <input
              value={f.partyPhone ?? ""}
              onChange={(e) => set({ partyPhone: e.target.value })}
              className={cls}
              aria-label="Job mobile"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground font-medium">Due</span>
            <input
              type="date"
              value={f.dueDate ?? ""}
              onChange={(e) => set({ dueDate: e.target.value || undefined })}
              className={cls}
              aria-label="Job due date"
            />
          </label>
          <label className="flex flex-col gap-1 col-span-2 sm:col-span-4">
            <span className="text-muted-foreground font-medium">Address</span>
            <input
              value={f.partyAddress ?? ""}
              onChange={(e) => set({ partyAddress: e.target.value })}
              className={cls}
              aria-label="Job address"
            />
          </label>
          <label className="flex flex-col gap-1 col-span-2">
            <span className="text-muted-foreground font-medium">What is made *</span>
            <ItemPicker
              value={f.finishedItemId ?? ""}
              items={sizedItems}
              onChange={(it) => set({ finishedItemId: it.id, finishedItemName: it.name })}
              ariaLabel="Job item"
              className={cls}
            />
          </label>
          <label className="flex flex-col gap-1 col-span-2">
            <span className="text-muted-foreground font-medium">Type</span>
            <ComboInput
              value={f.type ?? ""}
              onValue={(v) => set({ type: v })}
              options={m.productTypes}
              ariaLabel="Job type"
              className={cls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground font-medium">Width *</span>
            <NumInput
              value={size.w}
              onValue={(n) => set({ size: { ...size, w: n } })}
              className={`${cls} text-right`}
              aria-label="Job width"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground font-medium">Height *</span>
            <NumInput
              value={size.h}
              onValue={(n) => set({ size: { ...size, h: n } })}
              className={`${cls} text-right`}
              aria-label="Job height"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground font-medium">Unit</span>
            <select
              value={size.unit}
              onChange={(e) => set({ size: { ...size, unit: e.target.value as LengthUnit } })}
              className={cls}
              aria-label="Job size unit"
            >
              {(["in", "cm", "mm"] as LengthUnit[]).map((u) => (
                <option key={u} value={u}>
                  {LENGTH_LABEL[u]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground font-medium">Pieces</span>
            <NumInput
              value={f.pieces ?? 1}
              onValue={(n) => set({ pieces: n })}
              className={`${cls} text-right`}
              aria-label="Job pieces"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground font-medium">Operate side</span>
            <select
              value={f.operateSide ?? ""}
              onChange={(e) => set({ operateSide: e.target.value || undefined })}
              className={cls}
              aria-label="Job operate side"
            >
              <option value="">—</option>
              {m.operateSides.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground font-medium">Serial no.</span>
            <input
              value={f.serial ?? ""}
              onChange={(e) => set({ serial: e.target.value })}
              className={cls}
              aria-label="Job serial"
            />
          </label>
          <label className="flex flex-col gap-1 col-span-2">
            <span className="text-muted-foreground font-medium">Karigar</span>
            <input
              value={f.assignedTo ?? ""}
              onChange={(e) => set({ assignedTo: e.target.value })}
              className={cls}
              aria-label="Job karigar"
            />
          </label>
          <label className="flex flex-col gap-1 col-span-2 sm:col-span-4">
            <span className="text-muted-foreground font-medium">Note</span>
            <input
              value={f.note ?? ""}
              onChange={(e) => set({ note: e.target.value })}
              className={cls}
              aria-label="Job note"
              placeholder="e.g. 31-10 sanj sudhi ready kari apva"
            />
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save}>{card ? "Save" : "Create job card"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
