/**
 * Measure — a made-to-measure line on a quotation, proforma or bill.
 *
 * The window's W × H (inch / cm / mm), how many pieces, and what the job card
 * needs (type, operate side, serial, note). From the item's size-based BOM it
 * works out the area, the area charged, the cost and the minimum–maximum
 * selling rate — the shop's costing sheet — and turns the chosen rate into
 * the line's qty and price:
 *   item sold by sq ft → qty = sq ft charged × pieces, price = rate per sq ft
 *   item sold by piece → qty = pieces,                 price = rate per piece
 * Every bill calculation then reads qty and price as on any other line.
 */
import { useState } from "react";
import type { Bom, Item, LineItem, LineSize } from "@/types";
import { costSheet } from "@/lib/sizing";
import { areaUnitOf, LENGTH_LABEL, type LengthUnit } from "@/lib/units";
import { mtmOf } from "@/lib/mtm";
import { CompanyRepo } from "@/repositories";
import { fmtMoney } from "@/lib/format";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NumInput } from "@/components/NumInput";
import { ComboInput } from "@/components/ComboInput";
import { AlertTriangle } from "lucide-react";

const r2 = (n: number) => Math.round(n * 100) / 100;

export function MeasureDialog({
  line,
  item,
  bom,
  itemsById,
  rateOf,
  onClose,
  onSave,
}: {
  line: LineItem | null;
  item: Item | undefined;
  bom: Bom | undefined;
  itemsById: Map<string, Item>;
  rateOf: (i: Item) => number;
  onClose: () => void;
  onSave: (patch: { size: LineSize; qty: number; price: number }) => void;
}) {
  const mtm = mtmOf(CompanyRepo.get());
  const [form, setForm] = useState<LineSize | null>(null);
  const [rate, setRate] = useState(0);
  const [forLine, setForLine] = useState<string | null>(null);

  const open = !!line && !!bom;
  // A fresh form each time a line is opened.
  if (open && forLine !== line!.id) {
    setForLine(line!.id);
    const s = line!.size;
    setForm(
      s ?? {
        w: 0,
        h: 0,
        unit: mtm.sizeUnit,
        pieces: 1,
        sqft: 0,
        chargeableSqft: 0,
        type: mtm.productTypes[0],
        operateSide: undefined,
        serial: undefined,
        note: undefined,
        bomId: bom!.id,
      },
    );
    setRate(0);
  }
  if (!open && forLine) setForLine(null);
  if (!open || !form || !bom) return null;

  const sheet =
    form.w > 0 && form.h > 0
      ? costSheet(bom, { w: form.w, h: form.h, unit: form.unit }, itemsById, rateOf, {
          constants: mtm.constants,
          minSqft: mtm.minSqft,
        })
      : null;
  const perSqft = (sheet?.basis ?? bom.sizing?.pricing?.basis ?? "sqft") === "sqft";
  const byArea = !!areaUnitOf(item?.unit);
  // The rate shown: what the person typed, else what the line already had,
  // else the maximum the costing sheet allows.
  const existingRate =
    line!.size && line!.price > 0
      ? byArea
        ? perSqft
          ? line!.price
          : line!.price * (line!.size.chargeableSqft || 1)
        : perSqft
          ? line!.price / (line!.size.chargeableSqft || 1)
          : line!.price
      : 0;
  const shownRate = rate || r2(existingRate) || (sheet ? Math.round(sheet.maxRate) : 0);
  const below = sheet && shownRate > 0 && shownRate < sheet.minRate - 0.005;

  const save = () => {
    if (!sheet) return;
    const pieces = Math.max(1, Math.floor(form.pieces || 1));
    const charge = sheet.chargeableSqft;
    const perPiece = perSqft ? shownRate * charge : shownRate;
    const qty = byArea ? r2(charge * pieces) : pieces;
    const price = byArea ? r2(charge > 0 ? perPiece / charge : 0) : r2(perPiece);
    onSave({
      size: {
        ...form,
        pieces,
        sqft: sheet.sqft,
        chargeableSqft: charge,
        type: form.type?.trim() || undefined,
        operateSide: form.operateSide?.trim() || undefined,
        serial: form.serial?.trim() || undefined,
        note: form.note?.trim() || undefined,
        bomId: bom.id,
      },
      qty,
      price,
    });
  };

  const set = (patch: Partial<LineSize>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const cls =
    "h-9 w-full px-2 border rounded bg-background text-[16px] sm:text-[13px] outline-none focus:border-primary";
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Measure — {line!.name}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[12px]">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground font-medium">Width *</span>
            <NumInput
              value={form.w}
              onValue={(n) => set({ w: n })}
              className={`${cls} text-right`}
              aria-label="Measure width"
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground font-medium">Height *</span>
            <NumInput
              value={form.h}
              onValue={(n) => set({ h: n })}
              className={`${cls} text-right`}
              aria-label="Measure height"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground font-medium">Unit</span>
            <select
              value={form.unit}
              onChange={(e) => set({ unit: e.target.value as LengthUnit })}
              className={cls}
              aria-label="Measure unit"
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
              value={form.pieces}
              onValue={(n) => set({ pieces: n })}
              className={`${cls} text-right`}
              aria-label="Measure pieces"
            />
          </label>
          <label className="flex flex-col gap-1 col-span-2">
            <span className="text-muted-foreground font-medium">Type</span>
            <ComboInput
              value={form.type ?? ""}
              onValue={(v) => set({ type: v })}
              options={mtm.productTypes}
              ariaLabel="Blind type"
              className={cls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground font-medium">Operate side</span>
            <select
              value={form.operateSide ?? ""}
              onChange={(e) => set({ operateSide: e.target.value || undefined })}
              className={cls}
              aria-label="Operate side"
            >
              <option value="">—</option>
              {mtm.operateSides.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground font-medium">Serial no.</span>
            <input
              value={form.serial ?? ""}
              onChange={(e) => set({ serial: e.target.value })}
              className={cls}
              aria-label="Serial number"
              placeholder="e.g. 1221"
            />
          </label>
          <label className="flex flex-col gap-1 col-span-2 sm:col-span-4">
            <span className="text-muted-foreground font-medium">Note for the karigar</span>
            <input
              value={form.note ?? ""}
              onChange={(e) => set({ note: e.target.value })}
              className={cls}
              aria-label="Job note"
              placeholder="e.g. 31-10 sanj sudhi ready"
            />
          </label>
        </div>

        {sheet ? (
          <div
            className="rounded-md border bg-muted/30 p-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-[12px]"
            data-measure-sheet
          >
            <Info label="Area" value={`${r2(sheet.sqft)} sq ft`} />
            <Info label="Charged" value={`${r2(sheet.chargeableSqft)} sq ft`} />
            <Info
              label={perSqft ? "Cost / sq ft" : "Cost / piece"}
              value={fmtMoney(sheet.withAddOn)}
            />
            <Info
              label="Min – max"
              value={`${fmtMoney(sheet.minRate)} – ${fmtMoney(sheet.maxRate)}`}
            />
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">
            Enter the width and height to see the cost and the selling rate.
          </p>
        )}
        {sheet && sheet.problems.length > 0 && (
          <p className="text-[12px] text-amber-700 flex gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> The BOM has a formula problem:{" "}
            {sheet.problems[0].where} — {sheet.problems[0].message}
          </p>
        )}

        <div className="flex items-end justify-between gap-3 flex-wrap">
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="text-muted-foreground font-medium">
              Rate {perSqft ? "per sq ft" : "per piece"} (₹)
            </span>
            <NumInput
              value={shownRate}
              onValue={setRate}
              className={`${cls} text-right w-36 ${below ? "border-amber-500" : ""}`}
              aria-label="Selling rate"
            />
          </label>
          {sheet && (
            <p className="text-[12.5px]">
              {form.pieces || 1} ×{" "}
              {fmtMoney(perSqft ? shownRate * sheet.chargeableSqft : shownRate)} ={" "}
              <b>
                {fmtMoney(
                  (form.pieces || 1) * (perSqft ? shownRate * sheet.chargeableSqft : shownRate),
                )}
              </b>
            </p>
          )}
        </div>
        {below && (
          <p className="text-[12px] text-amber-700 flex gap-1.5" role="alert">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> Below the minimum selling rate
            ({fmtMoney(sheet!.minRate)}) — allowed, but check the margin.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!sheet}>
            Use this size
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground">{label}</p>
      <p className="font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/** "W 58" × H 35" · 2 pcs · Easy Lift · Right" — under the item name. */
export function sizeLine(s: LineSize): string {
  const u = s.unit === "in" ? '"' : ` ${s.unit}`;
  const n = (x: number) => String(Math.round((Number(x) || 0) * 100) / 100);
  return [
    `W ${n(s.w)}${u} × H ${n(s.h)}${u}`,
    s.pieces > 1 ? `${s.pieces} pcs` : null,
    `${n(s.chargeableSqft)} sq ft`,
    s.type,
    s.operateSide,
    s.serial ? `#${s.serial}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
