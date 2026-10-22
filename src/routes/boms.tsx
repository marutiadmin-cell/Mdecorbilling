import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { DataTable, type Column } from "@/components/DataTable";
import { BomRepo, ItemRepo, ProductionRepo } from "@/repositories";
import { genId } from "@/repositories/base";
import { useRepoData, useRepoMemo } from "@/hooks/useRepoData";
import { useStickyState } from "@/hooks/useStickySearch";
import { useAutoFocusOnDesktop } from "@/hooks/use-mobile";
import { usePermissions } from "@/hooks/usePermissions";
import { matchesQuery } from "@/lib/search";
import { fmtMoney } from "@/lib/format";
import { bomCycle, bomUnitCost, MAX_BOM_COMPONENTS } from "@/lib/production";
import type { Bom, BomComponent, CostLine, Item } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/Field";
import { NumInput } from "@/components/NumInput";
import { ItemPicker } from "@/components/ItemPicker";
import { ComboInput } from "@/components/ComboInput";
import { ClipboardList, Plus, Pencil, Trash2, Search, X, Archive } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/boms")({ component: BomsPage });

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Starting suggestions for the labour/overhead lines; anything else can be
 *  typed. */
const COST_LABELS = [
  "Karigar labour",
  "Stitching",
  "Upholstery labour",
  "Carpentry",
  "Polish",
  "Fitting / installation",
  "Transport",
  "Electricity & overhead",
];

const itemsMap = (items: Item[]) => new Map(items.map((i) => [i.id, i] as const));

function BomsPage() {
  const { isOwner, canEdit, canDelete } = usePermissions();
  const editAllowed = isOwner || canEdit("masterData");
  const deleteAllowed = isOwner || canDelete("masterData");
  const _repoV = useRepoData();
  const [q, setQ] = useStickyState("boms.search", "");
  const [showArchived, setShowArchived] = useState(false);
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Bom | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useAutoFocusOnDesktop(searchRef);

  const items = useRepoMemo(() => ItemRepo.all());
  const byId = itemsMap(items);
  const rows = useRepoMemo(
    () =>
      BomRepo.all()
        .filter((b) => (showArchived ? b.archived : !b.archived))
        .filter((b) => !q.trim() || matchesQuery(q, `${b.name} ${b.finishedItemName}`))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [q, showArchived],
  );
  void _repoV;

  const costOf = (b: Bom) => bomUnitCost(b, byId);
  const saleOf = (b: Bom) => byId.get(b.finishedItemId)?.salePrice ?? 0;

  const remove = (b: Bom) => {
    if (!deleteAllowed) {
      toast.error("You don't have permission to delete BOMs");
      return;
    }
    const used = ProductionRepo.all().filter((p) => p.bomId === b.id).length;
    if (used) {
      // Productions keep their own copy of what they used, so deleting would
      // be safe for the books — but the recipe history would read as if it
      // never existed. Archiving hides it from new runs and keeps the name.
      if (confirm(`"${b.name}" was used by ${used} production run(s). Archive it instead?`)) {
        BomRepo.update(b.id, { archived: true });
        toast.success("BOM archived — hidden from new production runs");
      }
      return;
    }
    if (confirm(`Delete BOM "${b.name}"? This moves no stock.`)) {
      BomRepo.remove(b.id);
      toast.success("BOM deleted");
    }
  };

  const columns: Column<Bom>[] = [
    {
      key: "name",
      label: "BOM",
      render: (b) => <span className="font-medium">{b.name}</span>,
      sortValue: (b) => b.name,
    },
    {
      key: "item",
      label: "Makes",
      width: "190px",
      render: (b) => `${b.outputQty} × ${byId.get(b.finishedItemId)?.name ?? b.finishedItemName}`,
    },
    {
      key: "cost",
      label: "Cost / unit",
      width: "120px",
      align: "right",
      render: (b) => fmtMoney(costOf(b)),
      sortValue: (b) => costOf(b),
    },
    {
      key: "margin",
      label: "Sale price · margin",
      width: "170px",
      align: "right",
      render: (b) => {
        const sale = saleOf(b);
        if (!sale) return "—";
        const m = ((sale - costOf(b)) / sale) * 100;
        return (
          <span className="whitespace-nowrap">
            {fmtMoney(sale)} ·{" "}
            <span className={m < 0 ? "text-rose-600" : "text-emerald-700"}>{m.toFixed(1)}%</span>
          </span>
        );
      },
    },
    {
      key: "actions",
      label: "Action",
      width: "90px",
      align: "center",
      render: (b) => (
        <span className="inline-flex items-center justify-center gap-0.5">
          {editAllowed && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEdit(b);
                setOpen(true);
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md text-gray-400 hover:bg-primary-soft hover:text-primary"
              title="Edit BOM"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {deleteAllowed && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                remove(b);
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md text-gray-400 hover:bg-rose-50 hover:text-rose-600"
              title="Delete BOM"
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
        title="Bill of Materials"
        subtitle={`${rows.length} ${showArchived ? "archived" : "active"} recipe${rows.length === 1 ? "" : "s"} — what each sofa, curtain or mattress is made of`}
        icon={<ClipboardList className="h-5 w-5" />}
        actions={
          editAllowed && (
            <Button
              size="sm"
              onClick={() => {
                setEdit(null);
                setOpen(true);
              }}
              className="w-full sm:w-auto"
            >
              <Plus className="h-3.5 w-3.5" /> New BOM
            </Button>
          )
        }
      />
      <div className="px-4 md:px-6 pt-3 flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search BOMs…"
            className="w-full h-9 sm:h-8 pl-8 pr-2 border rounded bg-background text-[16px] sm:text-[13px] outline-none focus:border-primary"
          />
        </div>
        <button
          onClick={() => setShowArchived((v) => !v)}
          className={`h-9 sm:h-8 px-2.5 rounded border text-[12px] inline-flex items-center gap-1.5 ${showArchived ? "bg-primary-soft text-primary border-primary/30" : "text-muted-foreground"}`}
        >
          <Archive className="h-3.5 w-3.5" /> Archived
        </button>
      </div>

      {/* Phone: one card per recipe */}
      <div className="md:hidden flex-1 overflow-auto mt-2">
        {rows.length === 0 ? (
          <EmptyBoms />
        ) : (
          <div className="divide-y divide-gray-100">
            {rows.map((b) => (
              <div
                key={b.id}
                onClick={() => {
                  if (!editAllowed) return;
                  setEdit(b);
                  setOpen(true);
                }}
                className="bg-white px-4 py-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-[13px] truncate">{b.name}</p>
                  <p className="text-[13px] font-bold tabular-nums shrink-0">
                    {fmtMoney(costOf(b))}
                  </p>
                </div>
                <p className="text-[11px] text-gray-400 mt-1 truncate">
                  Makes {b.outputQty} × {b.finishedItemName} · {b.components.length} materials
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="hidden md:flex flex-1 min-h-0 p-6 pt-3">
        {rows.length === 0 ? (
          <div className="flex-1">
            <EmptyBoms />
          </div>
        ) : (
          <DataTable
            storageKey="boms"
            columns={columns}
            rows={rows}
            rowKey={(b) => b.id}
            activateOnClick={editAllowed}
            onRowActivate={
              editAllowed
                ? (b) => {
                    setEdit(b);
                    setOpen(true);
                  }
                : undefined
            }
            onDelete={remove}
          />
        )}
      </div>
      <BomDialog open={open} onOpenChange={setOpen} bom={edit} items={items} />
    </div>
  );
}

function EmptyBoms() {
  return (
    <div className="text-center py-16 text-gray-400 px-6">
      <ClipboardList className="h-10 w-10 mx-auto mb-3 text-gray-200" />
      <p className="font-medium">No BOMs yet</p>
      <p className="text-[12px] mt-1 max-w-sm mx-auto">
        A BOM is the recipe for a finished item — e.g. 1 sofa = 12 m fabric + 4 foam sheets + frame
        + labour. Mark items as Raw material / Finished good on the Items page first.
      </p>
    </div>
  );
}

type DraftComponent = BomComponent & { key: string };

const blankComponent = (): DraftComponent => ({
  key: genId(),
  itemId: "",
  itemName: "",
  unit: "",
  qty: 0,
  wastagePct: 0,
});

function BomDialog({
  open,
  onOpenChange,
  bom,
  items,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  bom: Bom | null;
  items: Item[];
}) {
  const [name, setName] = useState("");
  const [finishedId, setFinishedId] = useState("");
  const [outputQty, setOutputQty] = useState(1);
  const [components, setComponents] = useState<DraftComponent[]>([]);
  const [costs, setCosts] = useState<CostLine[]>([]);
  const [notes, setNotes] = useState("");
  const [archived, setArchived] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    savingRef.current = false;
    setName(bom?.name ?? "");
    setFinishedId(bom?.finishedItemId ?? "");
    setOutputQty(bom?.outputQty ?? 1);
    setComponents(
      bom?.components.length
        ? bom.components.map((c) => ({ ...c, key: genId() }))
        : [blankComponent(), blankComponent()],
    );
    setCosts(
      bom?.additionalCosts.length ? bom.additionalCosts : [{ label: "Karigar labour", amount: 0 }],
    );
    setNotes(bom?.notes ?? "");
    setArchived(!!bom?.archived);
  }, [open, bom]);

  const byId = itemsMap(items);
  const finished = byId.get(finishedId);
  // Finished goods first in the picker, then everything else — any item can
  // still be chosen (a trading item made here once is still a finished item).
  const finishedChoices = [...items].sort(
    (a, b) => Number(b.kind === "finished") - Number(a.kind === "finished"),
  );
  const materialChoices = [...items]
    .filter((i) => i.id !== finishedId)
    .sort((a, b) => Number(b.kind === "raw") - Number(a.kind === "raw"));

  const live = components.filter((c) => c.itemId && c.qty > 0);
  const draft: Bom = {
    id: bom?.id ?? "",
    name: name.trim(),
    finishedItemId: finishedId,
    finishedItemName: finished?.name ?? "",
    outputQty: outputQty > 0 ? outputQty : 1,
    components: live.map(({ key: _k, ...c }) => {
      void _k;
      return { ...c, itemName: byId.get(c.itemId)?.name ?? c.itemName };
    }),
    additionalCosts: costs
      .map((c) => ({ label: c.label.trim(), amount: r2(c.amount || 0) }))
      .filter((c) => c.label && c.amount),
    createdAt: bom?.createdAt ?? "",
  };
  const unitCost = bomUnitCost(draft, byId);
  const materialPerUnit = r2(
    draft.components.reduce(
      (s, c) =>
        s +
        (c.qty / draft.outputQty) *
          (1 + (c.wastagePct ?? 0) / 100) *
          (byId.get(c.itemId)?.purchasePrice ?? 0),
      0,
    ),
  );
  const sale = finished?.salePrice ?? 0;

  const patchComponent = (key: string, patch: Partial<DraftComponent>) =>
    setComponents((list) => list.map((c) => (c.key === key ? { ...c, ...patch } : c)));

  const save = () => {
    if (savingRef.current) return;
    if (!finishedId || !finished) {
      toast.error("Choose the finished item this BOM makes");
      return;
    }
    if (!(outputQty > 0)) {
      toast.error("Output quantity must be more than 0");
      return;
    }
    if (!draft.components.length) {
      toast.error("Add at least one material with a quantity");
      return;
    }
    if (components.some((c) => !c.itemId && c.qty > 0)) {
      toast.error("A material row has a quantity but no item — pick it from the list");
      return;
    }
    if (draft.components.length > MAX_BOM_COMPONENTS) {
      toast.error(`A BOM can have at most ${MAX_BOM_COMPONENTS} materials`);
      return;
    }
    const seen = new Set<string>();
    for (const c of draft.components) {
      if (seen.has(c.itemId)) {
        toast.error(`"${c.itemName}" is listed twice — put its total on one row`);
        return;
      }
      seen.add(c.itemId);
    }
    const cycle = bomCycle(draft, BomRepo.all(), (id) => byId.get(id)?.name ?? "this item");
    if (cycle) {
      toast.error(cycle, { duration: 8000 });
      return;
    }
    savingRef.current = true;
    const record = {
      ...draft,
      name: draft.name || finished.name,
      notes: notes.trim() || undefined,
      archived: archived || undefined,
    };
    if (bom) {
      BomRepo.update(bom.id, record);
      toast.success("BOM updated");
    } else {
      BomRepo.add({ ...record, id: undefined });
      toast.success("BOM saved");
    }
    onOpenChange(false);
  };

  const inputCls =
    "h-9 sm:h-8 w-full px-2 border rounded bg-background text-[16px] sm:text-[13px] outline-none focus:border-primary focus:ring-1 focus:ring-primary";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle>{bom ? `Edit BOM — ${bom.name}` : "New Bill of Materials"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 min-w-0">
          <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
            <label className="flex flex-col gap-1 text-[12px] sm:col-span-3">
              <span className="text-muted-foreground font-medium">Finished item it makes *</span>
              <ItemPicker
                value={finishedId}
                items={finishedChoices}
                onChange={(it) => {
                  setFinishedId(it.id);
                  if (!name.trim()) setName(it.name);
                  // A material cannot also be what the recipe makes.
                  setComponents((list) => list.filter((c) => c.itemId !== it.id));
                }}
                ariaLabel="Finished item"
                autoFocus={!bom}
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="text-muted-foreground font-medium">Makes (qty)</span>
              <NumInput value={outputQty} onValue={setOutputQty} className={inputCls} />
            </label>
            <div className="sm:col-span-2">
              <Field
                label="BOM name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. 3-seater — velvet"
              />
            </div>
          </div>

          <div>
            <p className="text-[12px] font-semibold text-foreground mb-1.5">
              Materials for {outputQty > 0 ? outputQty : 1} unit{outputQty === 1 ? "" : "s"}
            </p>
            <div className="border rounded-md overflow-hidden">
              <div className="hidden sm:grid grid-cols-[minmax(0,1fr)_110px_70px_90px_110px_36px] gap-2 px-2 py-1.5 bg-muted text-[11px] font-semibold text-muted-foreground">
                <span>Material</span>
                <span className="text-right">Qty</span>
                <span>Unit</span>
                <span className="text-right">Wastage %</span>
                <span className="text-right">Cost</span>
                <span />
              </div>
              {components.map((c) => {
                const it = byId.get(c.itemId);
                const lineCost = r2(
                  (c.qty || 0) * (1 + (c.wastagePct ?? 0) / 100) * (it?.purchasePrice ?? 0),
                );
                return (
                  <div
                    key={c.key}
                    className="grid grid-cols-[minmax(0,1fr)_90px] sm:grid-cols-[minmax(0,1fr)_110px_70px_90px_110px_36px] gap-2 px-2 py-1.5 border-t items-center"
                  >
                    <ItemPicker
                      value={c.itemId}
                      items={materialChoices}
                      onChange={(item) =>
                        patchComponent(c.key, {
                          itemId: item.id,
                          itemName: item.name,
                          unit: item.unit,
                        })
                      }
                      ariaLabel="Material"
                      className={inputCls}
                    />
                    <NumInput
                      value={c.qty}
                      onValue={(n) => patchComponent(c.key, { qty: n })}
                      className={`${inputCls} text-right`}
                      aria-label="Material quantity"
                    />
                    <span className="hidden sm:block text-[12px] text-muted-foreground truncate">
                      {it?.unit ?? c.unit}
                    </span>
                    <NumInput
                      value={c.wastagePct ?? 0}
                      onValue={(n) => patchComponent(c.key, { wastagePct: Math.min(100, n) })}
                      className={`${inputCls} text-right hidden sm:block`}
                      aria-label="Wastage percent"
                    />
                    <span className="hidden sm:block text-right text-[12px] tabular-nums">
                      {fmtMoney(lineCost)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setComponents((list) => list.filter((x) => x.key !== c.key))}
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
              onClick={() => setComponents((list) => [...list, blankComponent()])}
            >
              <Plus className="h-3.5 w-3.5" /> Add material
            </Button>
          </div>

          <div>
            <p className="text-[12px] font-semibold text-foreground mb-1.5">
              Labour &amp; overhead for {outputQty > 0 ? outputQty : 1} unit
              {outputQty === 1 ? "" : "s"}
            </p>
            <div className="flex flex-col gap-2">
              {costs.map((c, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[minmax(0,1fr)_120px_36px] gap-2 items-center"
                >
                  <ComboInput
                    value={c.label}
                    onValue={(v) =>
                      setCosts((list) => list.map((x, j) => (j === i ? { ...x, label: v } : x)))
                    }
                    options={COST_LABELS}
                    ariaLabel="Cost name"
                    placeholder="e.g. Karigar labour"
                    className={inputCls}
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
          </div>

          <Field label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />

          {/* Estimate — at today's material prices, per finished unit */}
          <div className="rounded-md border bg-muted/40 p-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-[12px]">
            <Stat label="Materials / unit" value={fmtMoney(materialPerUnit)} />
            <Stat
              label="Labour & overhead / unit"
              value={fmtMoney(r2(unitCost - materialPerUnit))}
            />
            <Stat label="Cost / unit" value={fmtMoney(unitCost)} strong />
            <Stat
              label="Sale price · margin"
              value={
                sale
                  ? `${fmtMoney(sale)} · ${(((sale - unitCost) / sale) * 100).toFixed(1)}%`
                  : "Set a sale price on the item"
              }
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            {bom ? (
              <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={archived}
                  onChange={(e) => setArchived(e.target.checked)}
                />
                Archived (hidden from new production runs)
              </label>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={save}>
                Save BOM
              </Button>
            </div>
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
