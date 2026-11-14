import { useState } from "react";
import type { Bom, Item } from "@/types";
import { costSheet } from "@/lib/sizing";
import { LENGTH_UNITS, LENGTH_LABEL, type LengthUnit } from "@/lib/units";
import { NumInput } from "@/components/NumInput";
import { fmtMoney } from "@/lib/format";
import { AlertTriangle } from "lucide-react";

const f2 = (n: number) =>
  (Math.round(n * 100) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const f4 = (n: number) =>
  (Math.round(n * 10000) / 10000).toLocaleString("en-IN", { maximumFractionDigits: 4 });

/**
 * The shop's costing sheet, live: try any window size against a size-based
 * BOM and see every material, the total, the cost per sq ft and the minimum
 * and maximum selling rates — exactly the rows of their Excel sheet.
 */
export function SizeCalculator({
  bom,
  itemsById,
  rateOf,
  constants,
  minSqft,
  defaultUnit = "in",
}: {
  bom: Bom;
  itemsById: Map<string, Item>;
  rateOf: (item: Item) => number;
  constants: { key: string; value: number }[];
  minSqft?: number;
  defaultUnit?: LengthUnit;
}) {
  const [w, setW] = useState(48);
  const [h, setH] = useState(48);
  const [unit, setUnit] = useState<LengthUnit>(defaultUnit);
  const sheet = costSheet(bom, { w, h, unit }, itemsById, rateOf, { constants, minSqft });
  const perSqft = sheet.basis === "sqft";
  const cls =
    "h-8 w-full px-2 border rounded bg-background text-[16px] sm:text-[13px] text-right outline-none focus:border-primary";

  return (
    <div className="rounded-md border bg-muted/30 p-3 flex flex-col gap-3 min-w-0">
      <div className="flex items-end gap-2 flex-wrap">
        <p className="text-[12px] font-semibold mr-auto">Try a size — costing sheet</p>
        <label className="flex flex-col gap-0.5 text-[11px] text-muted-foreground w-20">
          Width
          <NumInput value={w} onValue={setW} className={cls} aria-label="Try width" />
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] text-muted-foreground w-20">
          Height
          <NumInput value={h} onValue={setH} className={cls} aria-label="Try height" />
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
          Unit
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value as LengthUnit)}
            className="h-8 px-1.5 border rounded bg-background text-[13px]"
            aria-label="Try unit"
          >
            {LENGTH_UNITS.filter((u) => u !== "ft" && u !== "m").map((u) => (
              <option key={u} value={u}>
                {LENGTH_LABEL[u]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {sheet.problems.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 text-amber-900 px-2.5 py-2 text-[12px] flex flex-col gap-1">
          {sheet.problems.map((p, i) => (
            <p key={i} className="flex gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                <b>{p.where}:</b> {p.message}
              </span>
            </p>
          ))}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-[12px] tabular-nums" aria-label="Costing sheet">
          <thead>
            <tr className="text-muted-foreground text-left">
              <th className="font-medium py-1 pr-2">Item</th>
              <th className="font-medium py-1 px-2 text-right">Qty</th>
              <th className="font-medium py-1 px-2 text-right">Rate</th>
              <th className="font-medium py-1 pl-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {sheet.lines.map((l, i) => (
              <tr key={i} className="border-t">
                <td className="py-1 pr-2">
                  {l.name || <span className="text-muted-foreground">— pick an item —</span>}
                  {l.unitMismatch && (
                    <span
                      className="ml-1 text-amber-700"
                      title="A length formula on an item not stocked by length"
                    >
                      ⚠ unit
                    </span>
                  )}
                </td>
                <td className="py-1 px-2 text-right">
                  {f4(l.qty)} <span className="text-muted-foreground">{l.unit}</span>
                </td>
                <td className="py-1 px-2 text-right">{f2(l.rate)}</td>
                <td className="py-1 pl-2 text-right">{f2(l.amount)}</td>
              </tr>
            ))}
            {sheet.costs.map((c, i) => (
              <tr key={`c${i}`} className="border-t">
                <td className="py-1 pr-2" colSpan={3}>
                  {c.label}
                </td>
                <td className="py-1 pl-2 text-right">{f2(c.amount)}</td>
              </tr>
            ))}
            <tr className="border-t-2 font-bold">
              <td className="py-1.5 pr-2" colSpan={3}>
                Total cost (one piece)
              </td>
              <td className="py-1.5 pl-2 text-right">{fmtMoney(sheet.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-[12px]">
        <Row label="Area" value={`${f4(sheet.sqft)} sq ft`} />
        {perSqft && sheet.chargeableSqft > sheet.sqft && (
          <Row label="Charged as (minimum)" value={`${f4(sheet.chargeableSqft)} sq ft`} />
        )}
        <Row
          label={perSqft ? "Cost per sq ft" : "Cost per piece"}
          value={fmtMoney(sheet.costPerUnit)}
        />
        <Row label="+ Maintenance / add-on" value={fmtMoney(sheet.withAddOn)} />
        <Row
          label={perSqft ? "Minimum sale / sq ft" : "Minimum sale"}
          value={fmtMoney(sheet.minRate)}
          strong
        />
        <Row
          label={perSqft ? "Maximum sale / sq ft" : "Maximum sale"}
          value={fmtMoney(sheet.maxRate)}
          strong
        />
        {perSqft && (
          <Row
            label="One piece sells at"
            value={`${fmtMoney(sheet.minPerPiece)} – ${fmtMoney(sheet.maxPerPiece)}`}
          />
        )}
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground">{label}</p>
      <p className={`tabular-nums ${strong ? "font-bold text-[13.5px]" : "font-medium"}`}>
        {value}
      </p>
    </div>
  );
}
