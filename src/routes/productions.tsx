import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
import {
  BomRepo,
  CompanyRepo,
  ItemRepo,
  PartyRepo,
  ProductionRepo,
  nextInvoiceNumber,
} from "@/repositories";
import { newBatch, commitBatch, genId } from "@/repositories/base";
import { useRepoData, useRepoMemo } from "@/hooks/useRepoData";
import { useStickyState } from "@/hooks/useStickySearch";
import { useAutoFocusOnDesktop } from "@/hooks/use-mobile";
import { usePermissions } from "@/hooks/usePermissions";
import { useFinancialYear } from "@/store/financialYear";
import { matchesQuery } from "@/lib/search";
import { fmtDate, fmtDateShort, fmtMoney, today } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";
import {
  consumptionFor,
  costToRestore,
  isWholeUnit,
  latestProductionOf,
  MAX_BOM_COMPONENTS,
  productionMovements,
  productionTotals,
  scaledCosts,
  stockShortfalls,
} from "@/lib/production";
import type { CostLine, Production, ProductionLine } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/Field";
import { NumInput } from "@/components/NumInput";
import { ItemPicker } from "@/components/ItemPicker";
import { ComboInput } from "@/components/ComboInput";
import { SelectMenu } from "@/components/SelectMenu";
import {
  Factory,
  Plus,
  Pencil,
  Trash2,
  Search,
  X,
  RefreshCw,
  AlertTriangle,
  Download,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/productions")({
  component: ProductionsPage,
  // ?open=<id> — the item history links a "Produced"/"Consumed" row here.
  validateSearch: (search: Record<string, unknown>): { open?: string } => ({
    open: typeof search.open === "string" ? search.open : undefined,
  }),
});

const r2 = (n: number) => Math.round(n * 100) / 100;

function ProductionsPage() {
  const { isOwner, canEdit, canDelete } = usePermissions();
  const editAllowed = isOwner || canEdit("masterData");
  const deleteAllowed = isOwner || canDelete("masterData");
  const _repoV = useRepoData();
  const navigate = useNavigate();
  const { open: openId } = Route.useSearch();
  const fy = useFinancialYear();
  const [q, setQ] = useStickyState("productions.search", "");
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Production | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useAutoFocusOnDesktop(searchRef);

  const rows = useRepoMemo(
    () =>
      ProductionRepo.all()
        .filter((p) => p.date >= fy.from && p.date <= fy.to)
        .filter(
          (p) =>
            !q.trim() ||
            matchesQuery(
              q,
              `${p.number} ${p.finishedItemName} ${p.partyName ?? ""} ${p.orderRef ?? ""}`,
            ),
        )
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
    [q, fy.from, fy.to],
  );
  void _repoV;

  // Arriving from an item's history: open that run once, then drop the
  // parameter so a refresh or Back does not reopen it.
  useEffect(() => {
    if (!openId) return;
    const p = ProductionRepo.get(openId);
    if (p) {
      setEdit(p);
      setOpen(true);
    }
    navigate({ to: "/productions", search: {}, replace: true });
  }, [openId, navigate]);

  const totalCost = r2(rows.reduce((s, p) => s + p.totalCost, 0));

  const remove = (p: Production) => {
    if (!deleteAllowed) {
      toast.error("You don't have permission to delete production runs");
      return;
    }
    const live = ProductionRepo.get(p.id);
    if (!live) {
      toast.info("This production run was already deleted");
      return;
    }
    const undo = productionMovements(live);
    const items = new Map(ItemRepo.all().map((i) => [i.id, i] as const));
    const short = stockShortfalls([], undo, items);
    if (short.length && CompanyRepo.get().allowNegativeStock === false) {
      toast.error(
        `Can't delete — taking the made units back would leave stock below zero (already sold?): ${short[0]}`,
        { duration: 8000 },
      );
      return;
    }
    const msg = [
      `Delete production ${live.number}?`,
      "",
      `${live.qty} × ${live.finishedItemName} will be taken back out of stock, and the materials put back.`,
      short.length ? `Warning — stock goes below zero: ${short.join("; ")}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    if (!confirm(msg)) return;
    const batch = newBatch();
    for (const m of undo) {
      if (ItemRepo.get(m.itemId)) ItemRepo.adjustFieldBatched(batch, m.itemId, "stock", -m.qty);
    }
    const restore = costToRestore(live, ItemRepo.get(live.finishedItemId), ProductionRepo.all());
    if (restore !== undefined && ItemRepo.get(live.finishedItemId)) {
      ItemRepo.adjustFieldBatched(batch, live.finishedItemId, "stock", 0, {
        purchasePrice: restore,
      });
    }
    ProductionRepo.removeBatched(batch, live.id);
    commitBatch(batch, "delete production").then((ok) => {
      if (!ok) {
        toast.error("Could not delete — reload and check before trying again");
        return;
      }
      toast.success("Production deleted — stock reversed");
    });
  };

  const exportCsv = () =>
    downloadCsv(
      `production-${fy.label.replace(/\s+/g, "")}`,
      [
        "Date",
        "No.",
        "Finished item",
        "Qty",
        "Unit",
        "For (customer)",
        "Order ref",
        "Material cost",
        "Labour & overhead",
        "Total cost",
        "Cost / unit",
        "Materials used",
      ],
      rows.map((p) => [
        fmtDate(p.date),
        p.number,
        p.finishedItemName,
        String(p.qty),
        p.unit,
        p.partyName ?? "",
        p.orderRef ?? "",
        String(p.materialCost),
        String(p.additionalCost),
        String(p.totalCost),
        String(p.unitCost),
        p.components.map((c) => `${c.itemName} ${c.qty} ${c.unit}`).join("; "),
      ]),
    );

  const columns: Column<Production>[] = [
    {
      key: "date",
      label: "Date",
      width: "95px",
      render: (p) => <span className="whitespace-nowrap">{fmtDateShort(p.date)}</span>,
      sortValue: (p) => p.date,
    },
    { key: "number", label: "No.", width: "95px", render: (p) => p.number },
    {
      key: "item",
      label: "Made",
      render: (p) => (
        <span>
          <span className="font-medium">
            {p.qty} × {p.finishedItemName}
          </span>
          {p.partyName && (
            <span className="text-muted-foreground text-[11px]">
              {" "}
              · for {p.partyName}
              {p.orderRef ? ` (${p.orderRef})` : ""}
            </span>
          )}
        </span>
      ),
      sortValue: (p) => p.finishedItemName,
    },
    {
      key: "total",
      label: "Total cost",
      width: "120px",
      align: "right",
      render: (p) => <span className="font-semibold">{fmtMoney(p.totalCost)}</span>,
      sortValue: (p) => p.totalCost,
    },
    {
      key: "unit",
      label: "Cost / unit",
      width: "110px",
      align: "right",
      render: (p) => fmtMoney(p.unitCost),
    },
    {
      key: "actions",
      label: "Action",
      width: "90px",
      align: "center",
      render: (p) => (
        <span className="inline-flex items-center justify-center gap-0.5">
          {editAllowed && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEdit(p);
                setOpen(true);
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md text-gray-400 hover:bg-primary-soft hover:text-primary"
              title="Edit production"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {deleteAllowed && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                remove(p);
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md text-gray-400 hover:bg-rose-50 hover:text-rose-600"
              title="Delete production"
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
        title="Production"
        subtitle={`${rows.length} run${rows.length === 1 ? "" : "s"} in ${fy.label} · ${fmtMoney(totalCost)} total cost`}
        icon={<Factory className="h-5 w-5" />}
        actions={
          <div className="flex gap-2 w-full sm:w-auto">
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={!rows.length}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            {editAllowed && (
              <Button
                size="sm"
                onClick={() => {
                  setEdit(null);
                  setOpen(true);
                }}
                className="flex-1 sm:flex-none"
              >
                <Plus className="h-3.5 w-3.5" /> New production
              </Button>
            )}
          </div>
        }
      />
      <div className="px-4 md:px-6 pt-3">
        <div className="relative max-w-sm">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search item, number, customer…"
            className="w-full h-9 sm:h-8 pl-8 pr-2 border rounded bg-background text-[16px] sm:text-[13px] outline-none focus:border-primary"
          />
        </div>
      </div>

      <div className="md:hidden flex-1 overflow-auto mt-2">
        {rows.length === 0 ? (
          <EmptyProductions />
        ) : (
          <div className="divide-y divide-gray-100">
            {rows.map((p) => (
              <div
                key={p.id}
                onClick={() => {
                  if (!editAllowed) return;
                  setEdit(p);
                  setOpen(true);
                }}
                className="bg-white px-4 py-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-[13px] truncate">
                    {p.qty} × {p.finishedItemName}
                  </p>
                  <p className="text-[13px] font-bold tabular-nums shrink-0">
                    {fmtMoney(p.totalCost)}
                  </p>
                </div>
                <p className="text-[11px] text-gray-400 mt-1 truncate">
                  {fmtDate(p.date)} · {p.number}
                  {p.partyName ? ` · for ${p.partyName}` : ""}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="hidden md:flex flex-1 min-h-0 p-6 pt-3">
        {rows.length === 0 ? (
          <div className="flex-1">
            <EmptyProductions />
          </div>
        ) : (
          <DataTable
            storageKey="productions"
            columns={columns}
            rows={rows}
            rowKey={(p) => p.id}
            activateOnClick={editAllowed}
            onRowActivate={
              editAllowed
                ? (p) => {
                    setEdit(p);
                    setOpen(true);
                  }
                : undefined
            }
            onDelete={remove}
          />
        )}
      </div>
      <ProductionDialog open={open} onOpenChange={setOpen} production={edit} />
    </div>
  );
}

function EmptyProductions() {
  return (
    <div className="text-center py-16 text-gray-400 px-6">
      <Factory className="h-10 w-10 mx-auto mb-3 text-gray-200" />
      <p className="font-medium">No production in this year</p>
      <p className="text-[12px] mt-1 max-w-sm mx-auto">
        Record a production run when sofas, curtains or mattresses are made: the materials go out of
        stock, the finished pieces come in, and their cost is worked out.
      </p>
    </div>
  );
}

type DraftLine = ProductionLine & { key: string };
const toDraft = (l: ProductionLine): DraftLine => ({ ...l, key: genId() });
const NO_BOM = "__none__";

function ProductionDialog({
  open,
  onOpenChange,
  production,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  production: Production | null;
}) {
  const items = useRepoMemo(() => ItemRepo.all());
  const boms = useRepoMemo(() => BomRepo.all());
  const parties = useRepoMemo(() => PartyRepo.all().filter((p) => !p.archived));
  const byId = new Map(items.map((i) => [i.id, i] as const));

  const [bomId, setBomId] = useState(NO_BOM);
  const [finishedId, setFinishedId] = useState("");
  const [qty, setQty] = useState(1);
  const [date, setDate] = useState(today());
  const [partyName, setPartyName] = useState("");
  const [orderRef, setOrderRef] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [costs, setCosts] = useState<CostLine[]>([]);
  const [roundUp, setRoundUp] = useState(true);
  /** The materials no longer match the BOM × qty — the person changed them. */
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    savingRef.current = false;
    setSaving(false);
    setBomId(production?.bomId && BomRepo.get(production.bomId) ? production.bomId : NO_BOM);
    setFinishedId(production?.finishedItemId ?? "");
    setQty(production?.qty ?? 1);
    setDate(production?.date ?? today());
    setPartyName(production?.partyName ?? "");
    setOrderRef(production?.orderRef ?? "");
    setNotes(production?.notes ?? "");
    setLines((production?.components ?? []).map(toDraft));
    setCosts(production?.additionalCosts ?? []);
    setTouched(!!production);
  }, [open, production]);

  const bom = bomId === NO_BOM ? undefined : BomRepo.get(bomId);
  const fillFromBom = (b = bom, q = qty, round = roundUp) => {
    if (!b) return;
    setLines(consumptionFor(b, q, byId, round).map(toDraft));
    setCosts(scaledCosts(b, q));
    setTouched(false);
  };

  const finished = byId.get(finishedId);
  const live = lines.filter((l) => l.itemId && l.qty > 0);
  const totals = productionTotals(live, costs, qty);
  const draft = {
    finishedItemId: finishedId,
    qty: r2(qty),
    components: live,
  };
  const short = finishedId
    ? stockShortfalls(
        productionMovements(draft),
        production ? productionMovements(production) : [],
        byId,
      )
    : [];
  const blockNegative = CompanyRepo.get().allowNegativeStock === false;
  const materialChoices = items
    .filter((i) => i.id !== finishedId)
    .sort((a, b) => Number(b.kind === "raw") - Number(a.kind === "raw"));
  const bomOptions = [
    { value: NO_BOM, label: "No BOM — enter materials" },
    ...boms
      .filter((b) => !b.archived || b.id === bomId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((b) => ({ value: b.id, label: `${b.name} (makes ${b.finishedItemName})` })),
  ];

  const patchLine = (key: string, patch: Partial<DraftLine>) => {
    setTouched(true);
    setLines((list) =>
      list.map((l) => {
        if (l.key !== key) return l;
        const next = { ...l, ...patch };
        return { ...next, amount: r2((next.qty || 0) * (next.rate || 0)) };
      }),
    );
  };

  const save = () => {
    if (savingRef.current) return;
    if (!finished) {
      toast.error("Choose the finished item made");
      return;
    }
    if (!(qty > 0)) {
      toast.error("Quantity made must be more than 0");
      return;
    }
    if (!date) {
      toast.error("Date required");
      return;
    }
    if (!live.length) {
      toast.error("Add the materials used");
      return;
    }
    if (lines.some((l) => !l.itemId && l.qty > 0)) {
      toast.error("A material row has a quantity but no item — pick it from the list");
      return;
    }
    if (live.some((l) => l.itemId === finishedId)) {
      toast.error(`"${finished.name}" cannot be used up making itself`);
      return;
    }
    if (live.length > MAX_BOM_COMPONENTS) {
      toast.error(`At most ${MAX_BOM_COMPONENTS} materials in one production run`);
      return;
    }
    if (short.length && blockNegative) {
      toast.error(`Not enough stock: ${short[0]}`, { duration: 8000 });
      return;
    }
    savingRef.current = true;
    setSaving(true);

    const party = parties.find(
      (p) => p.name.trim().toLowerCase() === partyName.trim().toLowerCase(),
    );
    const all = ProductionRepo.all();
    const batch = newBatch();

    // 1. Take back what the old version posted (edit), as every other edit
    //    path does — then post the new version. One batch: all or nothing.
    if (production) {
      for (const m of productionMovements(production)) {
        if (ItemRepo.get(m.itemId)) ItemRepo.adjustFieldBatched(batch, m.itemId, "stock", -m.qty);
      }
    }
    for (const m of productionMovements(draft)) {
      if (ItemRepo.get(m.itemId)) ItemRepo.adjustFieldBatched(batch, m.itemId, "stock", m.qty);
    }

    // 2. The finished item's cost. A new run sets it (last cost, the same rule
    //    a purchase follows). An edit re-prices it only while this run is
    //    still the latest and nothing has changed the price since; moving a
    //    run to a different item gives the old item back its earlier cost
    //    under the same conditions.
    let prevFinishedCost = production?.prevFinishedCost;
    let setCost = false;
    if (!production) {
      prevFinishedCost = finished.purchasePrice;
      setCost = true;
    } else if (production.finishedItemId === finishedId) {
      const isLatest = latestProductionOf(finishedId, all)?.id === production.id;
      const untouched = Math.abs((finished.purchasePrice ?? 0) - production.unitCost) <= 0.005;
      setCost = isLatest && untouched;
    } else {
      const restore = costToRestore(production, ItemRepo.get(production.finishedItemId), all);
      if (restore !== undefined && ItemRepo.get(production.finishedItemId)) {
        ItemRepo.adjustFieldBatched(batch, production.finishedItemId, "stock", 0, {
          purchasePrice: restore,
        });
      }
      prevFinishedCost = finished.purchasePrice;
      setCost = true;
    }
    if (setCost) {
      ItemRepo.adjustFieldBatched(batch, finishedId, "stock", 0, {
        purchasePrice: totals.unitCost,
      });
    }

    const record: Omit<Production, "id" | "createdAt"> = {
      number:
        production?.number ??
        nextInvoiceNumber(CompanyRepo.get().productionPrefix || "MFG-", ProductionRepo.all()),
      date,
      bomId: bom?.id,
      bomName: bom?.name,
      finishedItemId: finished.id,
      finishedItemName: finished.name,
      unit: finished.unit,
      qty: r2(qty),
      components: live.map(({ key: _k, ...l }) => {
        void _k;
        return {
          ...l,
          itemName: byId.get(l.itemId)?.name ?? l.itemName,
          amount: r2(l.qty * l.rate),
        };
      }),
      additionalCosts: costs
        .map((c) => ({ label: c.label.trim(), amount: r2(c.amount || 0) }))
        .filter((c) => c.label && c.amount),
      ...totals,
      partyId: party?.id,
      partyName: (party?.name ?? partyName.trim()) || undefined,
      orderRef: orderRef.trim() || undefined,
      notes: notes.trim() || undefined,
      prevFinishedCost,
    };
    if (production) ProductionRepo.updateBatched(batch, production.id, record);
    else ProductionRepo.addBatched(batch, record);

    commitBatch(batch, "save production").then((ok) => {
      savingRef.current = false;
      setSaving(false);
      if (!ok) {
        toast.error("Could not save — reload and check before trying again");
        return;
      }
      toast.success(
        `${production ? "Updated" : "Saved"} ${record.number} — ${record.qty} × ${finished.name} at ${fmtMoney(totals.unitCost)} each`,
      );
      onOpenChange(false);
    });
  };

  const inputCls =
    "h-9 sm:h-8 w-full px-2 border rounded bg-background text-[16px] sm:text-[13px] outline-none focus:border-primary focus:ring-1 focus:ring-primary";
  const sale = finished?.salePrice ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle>
            {production ? `Edit production ${production.number}` : "New production run"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 min-w-0">
          <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
            <label className="flex flex-col gap-1 text-[12px] sm:col-span-3">
              <span className="text-muted-foreground font-medium">BOM (recipe)</span>
              <SelectMenu<string>
                value={bomId}
                options={bomOptions}
                onChange={(v) => {
                  setBomId(v);
                  const b = v === NO_BOM ? undefined : BomRepo.get(v);
                  if (b) {
                    setFinishedId(b.finishedItemId);
                    fillFromBom(b, qty, roundUp);
                  }
                }}
                ariaLabel="BOM"
                className="w-full min-h-9 sm:min-h-8 px-2 py-1 justify-between text-[16px] sm:text-[13px]"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] sm:col-span-3">
              <span className="text-muted-foreground font-medium">Finished item made *</span>
              <ItemPicker
                value={finishedId}
                items={[...items].sort(
                  (a, b) => Number(b.kind === "finished") - Number(a.kind === "finished"),
                )}
                onChange={(it) => {
                  setFinishedId(it.id);
                  setLines((list) => list.filter((l) => l.itemId !== it.id));
                }}
                ariaLabel="Finished item"
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="text-muted-foreground font-medium">
                Qty made{finished ? ` (${finished.unit})` : ""} *
              </span>
              <NumInput
                value={qty}
                onValue={(n) => {
                  setQty(n);
                  if (bom && !touched && n > 0) fillFromBom(bom, n, roundUp);
                }}
                className={inputCls}
                aria-label="Quantity made"
              />
            </label>
            <div>
              <Field
                label="Date *"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <label className="flex flex-col gap-1 text-[12px] sm:col-span-2">
              <span className="text-muted-foreground font-medium">
                For customer (made to order)
              </span>
              <ComboInput
                value={partyName}
                onValue={setPartyName}
                options={parties.filter((p) => p.type !== "supplier").map((p) => p.name)}
                ariaLabel="Customer"
                placeholder="Optional — for stock leave blank"
                className={inputCls}
              />
            </label>
            <div className="sm:col-span-2">
              <Field
                label="Order / quotation ref"
                value={orderRef}
                onChange={(e) => setOrderRef(e.target.value)}
                placeholder="Optional"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
              <p className="text-[12px] font-semibold text-foreground">Materials used</p>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={roundUp}
                    onChange={(e) => {
                      setRoundUp(e.target.checked);
                      if (bom && !touched) fillFromBom(bom, qty, e.target.checked);
                    }}
                  />
                  Round up whole units (pcs, sets)
                </label>
                {bom && touched && (
                  <Button size="sm" variant="outline" onClick={() => fillFromBom()}>
                    <RefreshCw className="h-3.5 w-3.5" /> Recalculate from BOM
                  </Button>
                )}
              </div>
            </div>
            <div className="border rounded-md overflow-hidden">
              <div className="hidden sm:grid grid-cols-[minmax(0,1fr)_110px_60px_110px_110px_36px] gap-2 px-2 py-1.5 bg-muted text-[11px] font-semibold text-muted-foreground">
                <span>Material</span>
                <span className="text-right">Qty used</span>
                <span>Unit</span>
                <span className="text-right">Cost / unit</span>
                <span className="text-right">Amount</span>
                <span />
              </div>
              {lines.length === 0 && (
                <p className="px-3 py-3 text-[12px] text-muted-foreground border-t">
                  {bom ? "Enter the quantity made." : "Choose a BOM, or add materials below."}
                </p>
              )}
              {lines.map((l) => {
                const it = byId.get(l.itemId);
                return (
                  <div
                    key={l.key}
                    className="grid grid-cols-[minmax(0,1fr)_100px] sm:grid-cols-[minmax(0,1fr)_110px_60px_110px_110px_36px] gap-2 px-2 py-1.5 border-t items-center"
                  >
                    <ItemPicker
                      value={l.itemId}
                      items={materialChoices}
                      onChange={(item) =>
                        patchLine(l.key, {
                          itemId: item.id,
                          itemName: item.name,
                          unit: item.unit,
                          rate: r2(item.purchasePrice || 0),
                        })
                      }
                      ariaLabel="Material"
                      className={inputCls}
                    />
                    <NumInput
                      value={l.qty}
                      onValue={(n) => patchLine(l.key, { qty: n })}
                      className={`${inputCls} text-right`}
                      aria-label="Quantity used"
                    />
                    <span
                      className={`hidden sm:block text-[12px] truncate ${it && isWholeUnit(it.unit) && l.qty % 1 ? "text-amber-600" : "text-muted-foreground"}`}
                    >
                      {it?.unit ?? l.unit}
                    </span>
                    <NumInput
                      value={l.rate}
                      onValue={(n) => patchLine(l.key, { rate: n })}
                      className={`${inputCls} text-right hidden sm:block`}
                      aria-label="Cost per unit"
                    />
                    <span className="hidden sm:block text-right text-[12px] tabular-nums">
                      {fmtMoney(r2(l.qty * l.rate))}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setTouched(true);
                        setLines((list) => list.filter((x) => x.key !== l.key));
                      }}
                      className="hidden sm:inline-flex h-7 w-7 items-center justify-center rounded text-gray-400 hover:text-rose-600 hover:bg-rose-50"
                      title="Remove material"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => {
                setTouched(true);
                setLines((list) => [
                  ...list,
                  { key: genId(), itemId: "", itemName: "", unit: "", qty: 0, rate: 0, amount: 0 },
                ]);
              }}
            >
              <Plus className="h-3.5 w-3.5" /> Add material
            </Button>
          </div>

          <div>
            <p className="text-[12px] font-semibold text-foreground mb-1.5">
              Labour &amp; overhead for this run
            </p>
            <div className="flex flex-col gap-2">
              {costs.map((c, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[minmax(0,1fr)_120px_36px] gap-2 items-center"
                >
                  <Field
                    value={c.label}
                    onChange={(e) =>
                      setCosts((list) =>
                        list.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                      )
                    }
                    placeholder="e.g. Karigar labour"
                    aria-label="Cost name"
                  />
                  <NumInput
                    value={c.amount}
                    onValue={(n) =>
                      setCosts((list) => list.map((x, j) => (j === i ? { ...x, amount: n } : x)))
                    }
                    className={`${inputCls} text-right`}
                    aria-label="Cost amount"
                  />
                  <button
                    type="button"
                    onClick={() => setCosts((list) => list.filter((_, j) => j !== i))}
                    className="h-7 w-7 inline-flex items-center justify-center rounded text-gray-400 hover:text-rose-600 hover:bg-rose-50"
                    title="Remove cost"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => setCosts((list) => [...list, { label: "", amount: 0 }])}
            >
              <Plus className="h-3.5 w-3.5" /> Add labour / overhead
            </Button>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              Labour and overhead here go into the cost of what was made. Still record the actual
              wages and bills in Expenses when you pay them.
            </p>
          </div>

          <Field label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />

          {short.length > 0 && (
            <div
              className={`rounded-md border px-3 py-2 text-[12px] flex gap-2 ${blockNegative ? "border-rose-200 bg-rose-50 text-rose-700" : "border-amber-200 bg-amber-50 text-amber-800"}`}
            >
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">
                  {blockNegative
                    ? "Not enough stock — this run cannot be saved"
                    : "Stock will go below zero"}
                </p>
                <ul className="mt-0.5 list-disc pl-4">
                  {short.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div className="rounded-md border bg-muted/40 p-3 grid grid-cols-2 sm:grid-cols-5 gap-3 text-[12px]">
            <Stat label="Materials" value={fmtMoney(totals.materialCost)} />
            <Stat label="Labour & overhead" value={fmtMoney(totals.additionalCost)} />
            <Stat label="Total cost" value={fmtMoney(totals.totalCost)} />
            <Stat label="Cost / unit" value={fmtMoney(totals.unitCost)} strong />
            <Stat
              label="Sale price · margin"
              value={
                sale
                  ? `${fmtMoney(sale)} · ${(((sale - totals.unitCost) / sale) * 100).toFixed(1)}%`
                  : "—"
              }
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="button" disabled={saving} onClick={save}>
              {saving ? "Saving…" : production ? "Update production" : "Save production"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className={`tabular-nums ${strong ? "font-bold text-[14px]" : "font-medium"}`}>{value}</p>
    </div>
  );
}
