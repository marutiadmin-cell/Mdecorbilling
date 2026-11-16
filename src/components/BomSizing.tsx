/**
 * The made-to-measure half of the BOM screen: the switch, the formula rows,
 * the pricing block and the ready-made starters. Kept out of routes/boms.tsx
 * so a fixed BOM (a sofa model) renders exactly the screen it always did.
 */
import type { BomComponent, BomSizing, CostLine, Item } from "@/types";
import { syntaxError, FORMULA_HELP } from "@/lib/formula";
import { LENGTH_UNITS, LENGTH_LABEL, lengthUnitOf, type LengthUnit } from "@/lib/units";
import { ItemPicker } from "@/components/ItemPicker";
import { NumInput } from "@/components/NumInput";
import { genId } from "@/repositories/base";
import { Ruler, X, Plus, HelpCircle } from "lucide-react";
import { useState } from "react";

export type DraftComponent = BomComponent & { key: string; hint?: string };

/* ── Starters ──────────────────────────────────────────────────────────
   A starter fills the rows and formulas; the shop picks its own items
   (matched by name where one obviously fits) and checks the numbers.
   Formulas are written in INCHES. */
interface Starter {
  id: string;
  label: string;
  sizing: BomSizing;
  rows: { hint: string; match: RegExp; qtyFormula: string; resultUnit?: string }[];
  costs: CostLine[];
}
export const STARTERS: Starter[] = [
  {
    id: "venetian",
    label: "Wooden / aluminium venetian blind (Easy Lift)",
    sizing: {
      formulaUnit: "in",
      inputs: [
        { key: "SLAT_PITCH", label: "Slat pitch (in)", default: 1.13 },
        { key: "LADDER_GAP", label: "One ladder every (in)", default: 24 },
      ],
      pricing: {
        basis: "sqft",
        addPerUnit: 47,
        minMarginPct: 10,
        maxMarginPct: 54,
        roundLines: "up",
      },
    },
    rows: [
      {
        hint: "Bottom rail",
        // Not "Bottom lock" — that is its own row below.
        match: /bottom\s*(rail|bar)|^bottom$/i,
        qtyFormula: "W",
        resultUnit: "in",
      },
      { hint: "Slats", match: /slat/i, qtyFormula: "CEIL(H / SLAT_PITCH)" },
      { hint: "Head rail", match: /head\s*rail/i, qtyFormula: "W", resultUnit: "in" },
      { hint: "Mechanism", match: /mech/i, qtyFormula: "2" },
      { hint: "ATR", match: /\batr\b/i, qtyFormula: "CEIL(W / LADDER_GAP)" },
      { hint: "Chain", match: /chain/i, qtyFormula: "1" },
      { hint: "Ladder tape", match: /ladder/i, qtyFormula: "CEIL(W / LADDER_GAP)" },
      { hint: "Rod", match: /\brod\b/i, qtyFormula: "W", resultUnit: "in" },
      { hint: "Ceiling bracket", match: /bracket/i, qtyFormula: "2" },
      { hint: "Dori", match: /dori|cord/i, qtyFormula: "CEIL(W / LADDER_GAP)" },
      { hint: "Bottom lock", match: /bottom\s*lock/i, qtyFormula: "CEIL(W / LADDER_GAP)" },
    ],
    costs: [{ label: "Karigar labour", amount: 350 }],
  },
  {
    id: "roller",
    label: "Roller blind",
    sizing: {
      formulaUnit: "in",
      inputs: [{ key: "EXTRA_DROP", label: "Extra fabric for roll (in)", default: 12 }],
      pricing: {
        basis: "sqft",
        addPerUnit: 0,
        minMarginPct: 15,
        maxMarginPct: 50,
        roundLines: "none",
      },
    },
    rows: [
      {
        hint: "Roller fabric",
        match: /roller.*fabric|fabric/i,
        qtyFormula: "(H + EXTRA_DROP) * W / 144",
        resultUnit: "sqft",
      },
      { hint: "Tube", match: /tube/i, qtyFormula: "W", resultUnit: "in" },
      { hint: "Bottom bar", match: /bottom/i, qtyFormula: "W", resultUnit: "in" },
      { hint: "Bracket set", match: /bracket/i, qtyFormula: "1" },
      { hint: "Chain", match: /chain/i, qtyFormula: "1" },
    ],
    costs: [{ label: "Stitching", amount: 0, formula: "SQFT * 15" }],
  },
  {
    id: "curtain",
    label: "Curtain (padada)",
    sizing: {
      formulaUnit: "in",
      inputs: [
        { key: "FULLNESS", label: "Fullness (×)", default: 2 },
        { key: "FABRIC_W", label: "Fabric width (in)", default: 54 },
        { key: "HEMS", label: "Hems + heading (in)", default: 12 },
        { key: "PANEL_RATE", label: "Stitching per panel (₹)", default: 150 },
      ],
      pricing: {
        basis: "piece",
        addPerUnit: 0,
        minMarginPct: 25,
        maxMarginPct: 60,
        roundLines: "none",
      },
    },
    rows: [
      {
        hint: "Curtain fabric",
        match: /fabric|cloth/i,
        qtyFormula: "CEIL(W * FULLNESS / FABRIC_W) * (H + HEMS)",
        resultUnit: "in",
      },
      {
        hint: "Lining",
        match: /lining/i,
        qtyFormula: "CEIL(W * FULLNESS / FABRIC_W) * (H + HEMS)",
        resultUnit: "in",
      },
      { hint: "Track / rod", match: /track|rod|pipe/i, qtyFormula: "W", resultUnit: "in" },
      { hint: "Rings / hooks", match: /ring|hook|eyelet/i, qtyFormula: "CEIL(W * FULLNESS / 4)" },
    ],
    costs: [
      { label: "Stitching", amount: 0, formula: "CEIL(W * FULLNESS / FABRIC_W) * PANEL_RATE" },
    ],
  },
  {
    id: "sofa",
    label: "Sofa by seats",
    sizing: {
      formulaUnit: "in",
      inputs: [
        { key: "SEATS", label: "Seats", default: 3 },
        { key: "FABRIC_PER_SEAT", label: "Fabric per seat (m)", default: 4 },
      ],
      pricing: {
        basis: "piece",
        addPerUnit: 0,
        minMarginPct: 20,
        maxMarginPct: 45,
        roundLines: "nearest",
      },
    },
    rows: [
      {
        hint: "Sofa fabric",
        match: /fabric|velvet|cloth/i,
        qtyFormula: "SEATS * FABRIC_PER_SEAT",
        resultUnit: "m",
      },
      { hint: "Foam", match: /foam/i, qtyFormula: "SEATS * 2" },
      { hint: "Wooden frame", match: /frame/i, qtyFormula: "1" },
    ],
    costs: [{ label: "Upholstery labour", amount: 0, formula: "SEATS * 1500" }],
  },
];

/** The starter's rows, with the shop's item picked wherever exactly one
 *  item's name obviously fits. */
export function starterRows(s: Starter, items: Item[]): DraftComponent[] {
  return s.rows.map((r) => {
    const hits = items.filter((i) => i.kind !== "finished" && r.match.test(i.name));
    const it = hits.length === 1 ? hits[0] : undefined;
    // Slats kept by length: N pieces, each as wide as the blind.
    if (it?.pieces && r.hint === "Slats")
      return {
        key: genId(),
        hint: r.hint,
        itemId: it.id,
        itemName: it.name,
        unit: it.unit,
        qty: 0,
        wastagePct: 0,
        cut: { countFormula: r.qtyFormula, lengthFormula: "W" },
      };
    return {
      key: genId(),
      hint: r.hint,
      itemId: it?.id ?? "",
      itemName: it?.name ?? "",
      unit: it?.unit ?? "",
      qty: 0,
      wastagePct: 0,
      qtyFormula: r.qtyFormula,
      resultUnit: r.resultUnit,
    };
  });
}

/* ── The settings block ────────────────────────────────────────────── */
export function SizingSettings({
  sizing,
  onChange,
  onStarter,
  inputCls,
}: {
  sizing: BomSizing;
  onChange: (s: BomSizing) => void;
  onStarter: (s: Starter) => void;
  inputCls: string;
}) {
  const p = sizing.pricing ?? { basis: "sqft" as const };
  const setP = (patch: Partial<NonNullable<BomSizing["pricing"]>>) =>
    onChange({ ...sizing, pricing: { ...p, ...patch } });
  const inputs = sizing.inputs ?? [];
  const setInputs = (list: NonNullable<BomSizing["inputs"]>) =>
    onChange({ ...sizing, inputs: list });
  const [help, setHelp] = useState(false);

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3 flex flex-col gap-3 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <Ruler className="h-4 w-4 text-primary" />
        <p className="text-[12.5px] font-semibold mr-auto">
          Made to measure — quantities follow the size
        </p>
        <select
          aria-label="Start from"
          value=""
          onChange={(e) => {
            const s = STARTERS.find((x) => x.id === e.target.value);
            if (s) onStarter(s);
          }}
          className="h-8 px-2 border rounded bg-background text-[12.5px]"
        >
          <option value="">Start from a ready-made…</option>
          {STARTERS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setHelp((v) => !v)}
          className="h-8 px-2 inline-flex items-center gap-1 text-[12px] text-primary hover:underline"
        >
          <HelpCircle className="h-3.5 w-3.5" /> Formula help
        </button>
      </div>

      {help && (
        <div className="rounded border bg-background p-2.5 text-[12px] grid sm:grid-cols-2 gap-x-6 gap-y-1">
          {FORMULA_HELP.names.map(([n, d]) => (
            <p key={n}>
              <code className="font-semibold">{n}</code> — {d}
            </p>
          ))}
          {FORMULA_HELP.functions.map(([n, d]) => (
            <p key={n}>
              <code className="font-semibold">{n}</code> — {d}
            </p>
          ))}
          <p className="sm:col-span-2 text-muted-foreground">
            Example — slats: <code>CEIL(H / SLAT_PITCH)</code>; head rail answered in inches:{" "}
            <code>W</code> with "answer in" = inch (the app converts to the item's own unit). Inputs
            below and Settings → Manufacturing constants can be used by name.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 text-[12px]">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground font-medium">W, H in formulas</span>
          <select
            value={sizing.formulaUnit}
            onChange={(e) => onChange({ ...sizing, formulaUnit: e.target.value as LengthUnit })}
            className={inputCls}
            aria-label="Formula unit"
          >
            {LENGTH_UNITS.map((u) => (
              <option key={u} value={u}>
                {LENGTH_LABEL[u]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground font-medium">Sell by</span>
          <select
            value={p.basis}
            onChange={(e) => setP({ basis: e.target.value as "sqft" | "piece" })}
            className={inputCls}
            aria-label="Sell by"
          >
            <option value="sqft">Sq ft</option>
            <option value="piece">Piece</option>
          </select>
        </label>
        {p.basis === "sqft" && (
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground font-medium">Min. sq ft</span>
            <NumInput
              value={p.minSqft ?? 0}
              onValue={(n) => setP({ minSqft: n || undefined })}
              className={`${inputCls} text-right`}
              aria-label="Minimum sq ft"
            />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground font-medium">
            Maintenance / {p.basis === "sqft" ? "sq ft" : "piece"}
          </span>
          <NumInput
            value={p.addPerUnit ?? 0}
            onValue={(n) => setP({ addPerUnit: n })}
            className={`${inputCls} text-right`}
            aria-label="Maintenance add-on"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground font-medium">Min margin %</span>
          <NumInput
            value={p.minMarginPct ?? 0}
            onValue={(n) => setP({ minMarginPct: n })}
            className={`${inputCls} text-right`}
            aria-label="Minimum margin percent"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground font-medium">Max margin %</span>
          <NumInput
            value={p.maxMarginPct ?? 0}
            onValue={(n) => setP({ maxMarginPct: n })}
            className={`${inputCls} text-right`}
            aria-label="Maximum margin percent"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground font-medium">Round each line</span>
          <select
            value={p.roundLines ?? "none"}
            onChange={(e) => setP({ roundLines: e.target.value as "none" | "nearest" | "up" })}
            className={inputCls}
            aria-label="Round each line"
          >
            <option value="none">No (paise)</option>
            <option value="nearest">To nearest ₹</option>
            <option value="up">Up to next ₹</option>
          </select>
        </label>
      </div>

      <div>
        <p className="text-[12px] font-semibold mb-1">
          Inputs{" "}
          <span className="font-normal text-muted-foreground">
            (numbers the formulas use — the order can change them)
          </span>
        </p>
        <div className="flex flex-col gap-1.5">
          {inputs.map((inp, i) => (
            <div
              key={i}
              className="grid grid-cols-[110px_minmax(0,1fr)_90px_32px] gap-2 items-center"
            >
              <input
                value={inp.key}
                onChange={(e) =>
                  setInputs(
                    inputs.map((x, j) =>
                      j === i
                        ? { ...x, key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") }
                        : x,
                    ),
                  )
                }
                placeholder="NAME"
                aria-label="Input name"
                className={`${inputCls} font-mono`}
              />
              <input
                value={inp.label}
                onChange={(e) =>
                  setInputs(inputs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                }
                placeholder="What it means"
                aria-label="Input label"
                className={inputCls}
              />
              <NumInput
                value={inp.default}
                onValue={(n) =>
                  setInputs(inputs.map((x, j) => (j === i ? { ...x, default: n } : x)))
                }
                className={`${inputCls} text-right`}
                aria-label="Input default"
              />
              <button
                type="button"
                onClick={() => setInputs(inputs.filter((_, j) => j !== i))}
                className="h-7 w-7 inline-flex items-center justify-center rounded text-gray-400 hover:text-rose-600 hover:bg-rose-50"
                title="Remove input"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setInputs([...inputs, { key: "", label: "", default: 0 }])}
            className="self-start h-7 px-2 inline-flex items-center gap-1 text-[12px] text-primary hover:underline"
          >
            <Plus className="h-3.5 w-3.5" /> Add input
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Material rows with formulas ───────────────────────────────────── */
const ANSWER_UNITS = ["", ...LENGTH_UNITS, "sqft"] as const;

export function SizedMaterialRows({
  components,
  patch,
  remove,
  materialChoices,
  itemsById,
  inputCls,
}: {
  components: DraftComponent[];
  patch: (key: string, p: Partial<DraftComponent>) => void;
  remove: (key: string) => void;
  materialChoices: Item[];
  itemsById: Map<string, Item>;
  inputCls: string;
}) {
  return (
    <>
      <div className="hidden sm:grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_96px_80px_36px] gap-2 px-2 py-1.5 bg-muted text-[11px] font-semibold text-muted-foreground">
        <span>Material</span>
        <span>Quantity for one piece (number or formula)</span>
        <span>Answer in</span>
        <span className="text-right">Wastage %</span>
        <span />
      </div>
      {components.map((c) => {
        const it = itemsById.get(c.itemId);
        const err = c.qtyFormula?.trim() ? syntaxError(c.qtyFormula) : null;
        const itemUnit = it?.unit || c.unit;
        const lengthItem = !!lengthUnitOf(itemUnit);
        return (
          <div
            key={c.key}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_96px_80px_36px] gap-2 px-2 py-1.5 border-t items-center"
          >
            <ItemPicker
              value={c.itemId}
              items={materialChoices}
              onChange={(item) =>
                patch(c.key, { itemId: item.id, itemName: item.name, unit: item.unit })
              }
              ariaLabel="Material"
              placeholder={c.hint ? `Pick: ${c.hint}` : undefined}
              allowAdd
              newItemKind="raw"
              className={inputCls}
            />
            {c.cut ? (
              <div className="min-w-0 grid grid-cols-2 gap-1.5">
                <input
                  value={c.cut.countFormula}
                  onChange={(e) =>
                    patch(c.key, { cut: { ...c.cut!, countFormula: e.target.value } })
                  }
                  placeholder="pieces, e.g. CEIL(H / 1.13)"
                  aria-label="Cut pieces count"
                  title="How many pieces one blind needs"
                  spellCheck={false}
                  className={`${inputCls} font-mono ${c.cut.countFormula && syntaxError(c.cut.countFormula) ? "border-rose-500" : ""}`}
                />
                <input
                  value={c.cut.lengthFormula}
                  onChange={(e) =>
                    patch(c.key, { cut: { ...c.cut!, lengthFormula: e.target.value } })
                  }
                  placeholder="each long, e.g. W - 0.25"
                  aria-label="Cut piece length"
                  title="How long each piece is cut (in the unit at the right)"
                  spellCheck={false}
                  className={`${inputCls} font-mono ${c.cut.lengthFormula && syntaxError(c.cut.lengthFormula) ? "border-rose-500" : ""}`}
                />
              </div>
            ) : (
              <div className="min-w-0">
                <input
                  value={c.qtyFormula ?? ""}
                  onChange={(e) => patch(c.key, { qtyFormula: e.target.value })}
                  placeholder="e.g. 2  or  CEIL(H / 1.13)"
                  aria-label="Quantity formula"
                  aria-invalid={!!err}
                  title={err ? `${err.error} (at character ${err.pos + 1})` : undefined}
                  spellCheck={false}
                  className={`${inputCls} font-mono ${err ? "border-rose-500 focus:border-rose-500 focus:ring-rose-500" : ""}`}
                />
                {err && <p className="text-[11px] text-rose-600 mt-0.5">{err.error}</p>}
              </div>
            )}
            {c.cut ? (
              <select
                value={c.cut.lengthUnit ?? ""}
                onChange={(e) =>
                  patch(c.key, { cut: { ...c.cut!, lengthUnit: e.target.value || undefined } })
                }
                aria-label="Cut length unit"
                title="The unit each piece's length is in — converted to the item's own"
                className={`${inputCls} hidden sm:block`}
              >
                <option value="">length in W/H unit</option>
                {LENGTH_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {LENGTH_LABEL[u]}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={c.resultUnit ?? ""}
                onChange={(e) => patch(c.key, { resultUnit: e.target.value || undefined })}
                aria-label="Answer unit"
                title="The unit your formula answers in — converted to the item's own unit"
                className={`${inputCls} hidden sm:block`}
              >
                {ANSWER_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u === ""
                      ? `as item (${itemUnit || "—"})`
                      : u === "sqft"
                        ? "sq ft"
                        : LENGTH_LABEL[u as LengthUnit]}
                  </option>
                ))}
              </select>
            )}
            <NumInput
              value={c.wastagePct ?? 0}
              onValue={(n) => patch(c.key, { wastagePct: Math.min(100, n) })}
              className={`${inputCls} text-right hidden sm:block`}
              aria-label="Wastage percent"
            />
            <button
              type="button"
              onClick={() => remove(c.key)}
              className="hidden sm:inline-flex h-7 w-7 items-center justify-center rounded text-gray-400 hover:text-rose-600 hover:bg-rose-50"
              title="Remove material"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            {it?.pieces && (
              <label className="col-span-full flex items-center gap-2 text-[11.5px] text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!c.cut}
                  onChange={(e) =>
                    patch(c.key, {
                      cut: e.target.checked
                        ? { countFormula: c.qtyFormula?.trim() || "1", lengthFormula: "W" }
                        : undefined,
                    })
                  }
                  aria-label="Cut as pieces"
                />
                <span>
                  <b className="text-foreground">Cut as pieces</b> — {it.name} is kept by length;
                  production picks the pieces from stock and keeps the offcuts
                </span>
              </label>
            )}
            {c.resultUnit && lengthUnitOf(c.resultUnit) && it && !lengthItem && (
              <p className="col-span-full text-[11px] text-amber-700">
                The formula answers a length, but {it.name} is stocked in "{itemUnit}" — set the
                item's unit to a length (ft, m, in) or answer in "as item".
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}

/** A labour / overhead amount that may be a formula ("SQFT * 25"). */
export function AmountOrFormula({
  line,
  onChange,
  inputCls,
}: {
  line: CostLine;
  onChange: (l: CostLine) => void;
  inputCls: string;
}) {
  const text = line.formula ?? (line.amount ? String(line.amount) : "");
  const err = line.formula ? syntaxError(line.formula) : null;
  return (
    <input
      value={text}
      onChange={(e) => {
        const v = e.target.value;
        if (/^\s*\d*\.?\d*\s*$/.test(v)) onChange({ label: line.label, amount: Number(v) || 0 });
        else onChange({ label: line.label, amount: 0, formula: v });
      }}
      placeholder="350 or SQFT * 25"
      aria-label="Cost amount"
      aria-invalid={!!err}
      title={err ? err.error : undefined}
      spellCheck={false}
      className={`${inputCls} text-right font-mono ${err ? "border-rose-500" : ""}`}
    />
  );
}
