import { useEffect, useState } from "react";
import type { Company, MtmSettings } from "@/types";
import { mtmOf } from "@/lib/mtm";
import { LENGTH_LABEL, type LengthUnit } from "@/lib/units";
import { NumInput } from "@/components/NumInput";
import { Button } from "@/components/ui/button";
import { Plus, X, ArrowUp } from "lucide-react";
import { toast } from "sonner";

/**
 * Settings → Manufacturing: what made-to-measure work needs once per shop —
 * the unit orders are measured in, the minimum area charged, named numbers
 * for size formulas, and the lists a job card offers (product types, operate
 * sides, the stages a job goes through and which one means "made").
 *
 * Saved with an explicit button, not per keystroke: a half-typed constant
 * name would otherwise break every formula that uses it mid-edit.
 */
export function ManufacturingSettings({
  company,
  onSave,
}: {
  company: Company;
  onSave: (next: Company) => void;
}) {
  const [m, setM] = useState(() => mtmOf(company));
  useEffect(() => setM(mtmOf(company)), [company]);
  const set = (patch: Partial<typeof m>) => setM((x) => ({ ...x, ...patch }));
  const cls =
    "h-9 px-3 border rounded-md bg-background text-sm focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none";

  const save = () => {
    const keys = m.constants.map((c) => c.key.trim());
    if (keys.some((k) => !/^[A-Z_][A-Z0-9_]*$/.test(k))) {
      toast.error("Each constant needs a NAME of letters, digits and _ — e.g. SLAT_PITCH");
      return;
    }
    if (new Set(keys).size !== keys.length) {
      toast.error("Two constants have the same name");
      return;
    }
    if (!m.jobStages.length) {
      toast.error("Keep at least one job stage");
      return;
    }
    const mtm: MtmSettings = {
      sizeUnit: m.sizeUnit,
      minSqft: m.minSqft || undefined,
      constants: m.constants,
      productTypes: m.productTypes,
      operateSides: m.operateSides,
      jobStages: m.jobStages,
      completeStage: m.completeStage,
      jobPrefix: m.jobPrefix.trim() || "WB-",
    };
    onSave({ ...company, mtm });
    toast.success("Manufacturing settings saved");
  };

  return (
    <div className="p-5 flex flex-col gap-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-[12.5px]">
        <label className="flex flex-col gap-1">
          <span className="font-semibold text-gray-600">Orders measured in</span>
          <select
            value={m.sizeUnit}
            onChange={(e) => set({ sizeUnit: e.target.value as LengthUnit })}
            className={cls}
            aria-label="Default size unit"
          >
            {(["in", "cm", "mm"] as LengthUnit[]).map((u) => (
              <option key={u} value={u}>
                {LENGTH_LABEL[u]}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-gray-400">Each order can still change it.</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-semibold text-gray-600">Minimum sq ft charged</span>
          <NumInput
            value={m.minSqft}
            onValue={(n) => set({ minSqft: n })}
            className={`${cls} text-right`}
            aria-label="Minimum sq ft charged"
          />
          <span className="text-[11px] text-gray-400">
            A small blind is billed as at least this area.
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-semibold text-gray-600">Job card number prefix</span>
          <input
            value={m.jobPrefix}
            onChange={(e) => set({ jobPrefix: e.target.value })}
            className={cls}
            aria-label="Job card prefix"
          />
          <span className="text-[11px] text-gray-400">e.g. WB- gives WB-0001, WB-0002…</span>
        </label>
      </div>

      <div>
        <p className="text-[12.5px] font-semibold text-gray-600 mb-1">Formula constants</p>
        <p className="text-[11px] text-gray-400 mb-2">
          Named numbers every size formula can use — e.g. SLAT_PITCH = 1.13 makes{" "}
          <code>CEIL(H / SLAT_PITCH)</code> count slats.
        </p>
        <div className="flex flex-col gap-1.5">
          {m.constants.map((c, i) => (
            <div
              key={i}
              className="grid grid-cols-[140px_100px_minmax(0,1fr)_32px] gap-2 items-center"
            >
              <input
                value={c.key}
                onChange={(e) =>
                  set({
                    constants: m.constants.map((x, j) =>
                      j === i
                        ? { ...x, key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") }
                        : x,
                    ),
                  })
                }
                placeholder="NAME"
                aria-label="Constant name"
                className={`${cls} font-mono`}
              />
              <NumInput
                value={c.value}
                onValue={(n) =>
                  set({ constants: m.constants.map((x, j) => (j === i ? { ...x, value: n } : x)) })
                }
                className={`${cls} text-right`}
                aria-label="Constant value"
              />
              <input
                value={c.note ?? ""}
                onChange={(e) =>
                  set({
                    constants: m.constants.map((x, j) =>
                      j === i ? { ...x, note: e.target.value || undefined } : x,
                    ),
                  })
                }
                placeholder="What it is (optional)"
                aria-label="Constant note"
                className={cls}
              />
              <button
                type="button"
                onClick={() => set({ constants: m.constants.filter((_, j) => j !== i) })}
                className="rounded p-1 text-gray-400 hover:text-rose-600 hover:bg-rose-50"
                title="Remove constant"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => set({ constants: [...m.constants, { key: "", value: 0 }] })}
            className="self-start h-8 px-2 inline-flex items-center gap-1 text-[12.5px] text-primary hover:underline"
          >
            <Plus className="h-3.5 w-3.5" /> Add constant
          </button>
        </div>
      </div>

      <ChipList
        title="Product types (job card)"
        hint='Shown on the job card as "Type".'
        items={m.productTypes}
        onChange={(v) => set({ productTypes: v })}
        placeholder="e.g. Easy Lift (Single Dori / Chain System)"
      />
      <ChipList
        title="Operate sides"
        items={m.operateSides}
        onChange={(v) => set({ operateSides: v })}
        placeholder="e.g. Left"
      />
      <ChipList
        title="Job stages, in order"
        hint="A job card moves through these. Use ↑ to reorder."
        items={m.jobStages}
        onChange={(v) =>
          set({
            jobStages: v,
            completeStage: v.includes(m.completeStage)
              ? m.completeStage
              : v[Math.max(0, v.length - 2)],
          })
        }
        placeholder="e.g. Stitching"
        ordered
      />
      <label className="flex flex-col gap-1 text-[12.5px] max-w-xs">
        <span className="font-semibold text-gray-600">Stage that means "made"</span>
        <select
          value={m.completeStage}
          onChange={(e) => set({ completeStage: e.target.value })}
          className={cls}
          aria-label="Completing stage"
        >
          {m.jobStages.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-gray-400">
          Reaching it records the production — materials out of stock, the finished piece in.
        </span>
      </label>

      <div>
        <Button type="button" onClick={save}>
          Save manufacturing settings
        </Button>
      </div>
    </div>
  );
}

function ChipList({
  title,
  hint,
  items,
  onChange,
  placeholder,
  ordered,
}: {
  title: string;
  hint?: string;
  items: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  ordered?: boolean;
}) {
  const [text, setText] = useState("");
  const add = () => {
    const v = text.trim();
    if (!v) return;
    if (items.some((x) => x.toLowerCase() === v.toLowerCase())) {
      toast.error(`"${v}" is already in the list`);
      return;
    }
    onChange([...items, v]);
    setText("");
  };
  return (
    <div>
      <p className="text-[12.5px] font-semibold text-gray-600 mb-1">{title}</p>
      {hint && <p className="text-[11px] text-gray-400 mb-2">{hint}</p>}
      <div className="flex flex-wrap gap-2 mb-2">
        {items.map((v, i) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 pl-3 pr-1.5 py-1.5 rounded-full bg-primary-soft text-primary text-xs font-semibold"
          >
            {ordered && <span className="text-primary/60 mr-0.5">{i + 1}.</span>}
            {v}
            {ordered && i > 0 && (
              <button
                type="button"
                onClick={() => {
                  const next = [...items];
                  [next[i - 1], next[i]] = [next[i], next[i - 1]];
                  onChange(next);
                }}
                className="rounded-full p-0.5 hover:bg-primary/20"
                title={`Move "${v}" earlier`}
              >
                <ArrowUp className="h-3 w-3" />
              </button>
            )}
            <button
              type="button"
              onClick={() => onChange(items.filter((x) => x !== v))}
              className="rounded-full p-0.5 hover:bg-primary/20"
              title={`Remove "${v}"`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          aria-label={`Add to ${title}`}
          className="h-9 px-3 border rounded-md bg-background text-sm flex-1 focus:border-primary focus:ring-2 focus:ring-ring/20 outline-none"
        />
        <Button type="button" variant="outline" onClick={add}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
    </div>
  );
}
