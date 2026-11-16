/**
 * "Pieces by size" for a by-length item (slats, rails, rods) — on its page.
 *
 *   Size      Pieces   Length
 *   20 ft        2      40 ft
 *   10 ft        1      10 ft
 *   Unsorted             0 ft
 *
 * Sort into sizes  — unsorted length (a purchase by the foot) into pieces;
 *                    moves no stock (a PieceSort).
 * Add pieces       — pieces that come INTO stock (opening, a count, found):
 *                    a stock adjustment carrying the pieces.
 * Remove pieces    — pieces that LEAVE stock (damaged, scrapped): the same,
 *                    reduce; scrap is booked as Cutting wastage.
 * Sizes are worked out from those documents and from production cuts
 * (lib/pieces.ts) — never typed as a balance, so nothing can drift.
 */
import { useState } from "react";
import { pieceDataFromRepos } from "@/lib/pieceData";
import type { Item, PieceCount } from "@/types";
import { PieceSortRepo, StockAdjustmentRepo, ItemRepo } from "@/repositories";
import { newBatch, commitBatch } from "@/repositories/base";
import { useRepoMemo } from "@/hooks/useRepoData";
import { bagsOf, fmtLen } from "@/lib/pieces";
import { piecesLength, lenKey } from "@/lib/cutting";
import { today } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NumInput } from "@/components/NumInput";
import { Plus, X, Scissors } from "lucide-react";
import { toast } from "sonner";

type Mode = "sort" | "add" | "remove";

export function PiecesCard({ item, editAllowed }: { item: Item; editAllowed: boolean }) {
  const bags = useRepoMemo(
    () => bagsOf(item, pieceDataFromRepos()),
    [item.id, item.stock, item.pieces],
  );
  const [mode, setMode] = useState<Mode | null>(null);
  const u = item.unit;
  return (
    <div
      className="bg-white border rounded-lg shadow-sm overflow-hidden max-w-5xl mx-auto mb-4"
      data-pieces-card
    >
      <div className="px-5 py-3 border-b flex items-center gap-2 flex-wrap">
        <Scissors className="h-4 w-4 text-primary" />
        <p className="text-sm font-bold text-gray-800 mr-auto">Pieces by size</p>
        {editAllowed && (
          <>
            <Button size="sm" variant="outline" onClick={() => setMode("sort")}>
              Sort into sizes
            </Button>
            <Button size="sm" variant="outline" onClick={() => setMode("add")}>
              Add pieces
            </Button>
            <Button size="sm" variant="outline" onClick={() => setMode("remove")}>
              Remove pieces
            </Button>
          </>
        )}
      </div>
      <table className="w-full text-[13px] tabular-nums" aria-label="Pieces by size">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-muted-foreground bg-muted/40">
            <th className="text-left font-semibold px-5 py-2">Size</th>
            <th className="text-right font-semibold px-5 py-2">Pieces</th>
            <th className="text-right font-semibold px-5 py-2">Length</th>
          </tr>
        </thead>
        <tbody>
          {bags.pieces.length === 0 && (
            <tr>
              <td colSpan={3} className="px-5 py-3 text-muted-foreground text-[12.5px]">
                No sizes yet — use "Sort into sizes" to say what pieces the stock is in.
              </td>
            </tr>
          )}
          {bags.pieces.map((p) => (
            <tr key={p.length} className={`border-t ${p.count < 0 ? "text-rose-600" : ""}`}>
              <td className="px-5 py-2 font-medium">
                {fmtLen(p.length)} {u}
                {/^ft$/i.test(u) && (
                  <span className="text-muted-foreground"> ({fmtLen(p.length * 12)}")</span>
                )}
              </td>
              <td className="px-5 py-2 text-right">{p.count}</td>
              <td className="px-5 py-2 text-right">
                {fmtLen(p.length * p.count)} {u}
              </td>
            </tr>
          ))}
          <tr className="border-t bg-muted/20">
            <td className="px-5 py-2 text-muted-foreground">Unsorted (no size recorded)</td>
            <td />
            <td
              className={`px-5 py-2 text-right ${bags.loose < -0.001 ? "text-rose-600 font-semibold" : ""}`}
            >
              {fmtLen(bags.loose)} {u}
            </td>
          </tr>
          <tr className="border-t font-bold">
            <td className="px-5 py-2">Total in stock</td>
            <td className="px-5 py-2 text-right">
              {bags.pieces.reduce((s, p) => s + Math.max(0, p.count), 0)} pcs
            </td>
            <td className="px-5 py-2 text-right">
              {fmtLen(Number(item.stock) || 0)} {u}
            </td>
          </tr>
        </tbody>
      </table>
      {bags.loose < -0.001 && (
        <p className="px-5 py-2 text-[12px] text-rose-600 border-t">
          The sizes add up to more than the stock — remove the pieces that are no longer there.
        </p>
      )}
      <PiecesDialog
        mode={mode}
        onClose={() => setMode(null)}
        item={item}
        loose={bags.loose}
        sizes={bags.pieces}
      />
    </div>
  );
}

const TITLE: Record<Mode, string> = {
  sort: "Sort into sizes",
  add: "Add pieces to stock",
  remove: "Remove pieces from stock",
};

function PiecesDialog({
  mode,
  onClose,
  item,
  loose,
  sizes,
}: {
  mode: Mode | null;
  onClose: () => void;
  item: Item;
  loose: number;
  sizes: PieceCount[];
}) {
  const u = item.unit;
  const [rows, setRows] = useState<PieceCount[]>([]);
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [scrap, setScrap] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastMode, setLastMode] = useState<Mode | null>(null);
  if (mode !== lastMode) {
    setLastMode(mode);
    setRows([{ length: item.pieces?.barLength ?? 0, count: 0 }]);
    setDate(today());
    setNote("");
    setScrap(false);
    setSaving(false);
  }
  const live = rows
    .filter((r) => r.length > 0 && r.count > 0)
    .map((r) => ({ length: lenKey(r.length), count: Math.floor(r.count) }));
  const total = piecesLength(live);

  const save = async () => {
    if (!mode || saving) return;
    if (!live.length) {
      toast.error("Enter at least one size and how many pieces");
      return;
    }
    if (mode === "sort" && total > loose + 0.001) {
      toast.error(
        `Only ${fmtLen(loose)} ${u} is unsorted — these pieces add up to ${fmtLen(total)} ${u}`,
      );
      return;
    }
    if (mode === "remove") {
      for (const r of live) {
        const have = sizes.find((s) => s.length === r.length)?.count ?? 0;
        if (r.count > have) {
          toast.error(`Only ${have} piece(s) of ${fmtLen(r.length)} ${u} in stock`);
          return;
        }
      }
    }
    setSaving(true);
    const batch = newBatch();
    if (mode === "sort") {
      PieceSortRepo.addBatched(batch, {
        itemId: item.id,
        itemName: item.name,
        date,
        pieces: live,
        note: note.trim() || undefined,
      });
    } else {
      StockAdjustmentRepo.addBatched(batch, {
        itemId: item.id,
        itemName: item.name,
        date,
        type: mode === "add" ? "add" : "reduce",
        qty: total,
        pieces: live,
        kind: mode === "remove" && scrap ? "wastage" : undefined,
        reason:
          note.trim() ||
          (mode === "add" ? "Pieces added" : scrap ? "Cutting wastage" : "Pieces removed"),
      });
      ItemRepo.adjustFieldBatched(batch, item.id, "stock", mode === "add" ? total : -total);
    }
    const ok = await commitBatch(batch, TITLE[mode]);
    setSaving(false);
    if (!ok) return;
    toast.success(
      mode === "sort"
        ? `${fmtLen(total)} ${u} sorted into sizes`
        : mode === "add"
          ? `${fmtLen(total)} ${u} added to stock`
          : `${fmtLen(total)} ${u} removed from stock`,
    );
    onClose();
  };

  const cls =
    "h-9 w-full px-2 border rounded bg-background text-[16px] sm:text-[13px] text-right outline-none focus:border-primary";
  return (
    <Dialog open={!!mode} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode ? TITLE[mode] : ""} — {item.name}
          </DialogTitle>
        </DialogHeader>
        <p className="text-[12.5px] text-muted-foreground">
          {mode === "sort" &&
            `Say what sizes the unsorted ${fmtLen(loose)} ${u} is in. Stock does not change — only its sizes are recorded.`}
          {mode === "add" &&
            "Pieces coming INTO stock (opening stock, a count, found). Stock goes up by their total length."}
          {mode === "remove" &&
            "Pieces LEAVING stock (damaged, lost, scrapped). Stock goes down by their total length."}
        </p>
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[1fr_1fr_32px] gap-2 text-[11px] font-semibold text-muted-foreground">
            <span>Length of each piece ({u})</span>
            <span>How many pieces</span>
            <span />
          </div>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_32px] gap-2 items-center">
              <NumInput
                value={r.length}
                onValue={(n) =>
                  setRows((list) => list.map((x, j) => (j === i ? { ...x, length: n } : x)))
                }
                className={cls}
                aria-label="Piece length"
              />
              <NumInput
                value={r.count}
                onValue={(n) =>
                  setRows((list) => list.map((x, j) => (j === i ? { ...x, count: n } : x)))
                }
                className={cls}
                aria-label="Piece count"
              />
              <button
                type="button"
                onClick={() => setRows((list) => list.filter((_, j) => j !== i))}
                className="h-7 w-7 inline-flex items-center justify-center rounded text-gray-400 hover:text-rose-600 hover:bg-rose-50"
                title="Remove row"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setRows((list) => [...list, { length: 0, count: 0 }])}
            className="self-start h-8 px-2 inline-flex items-center gap-1 text-[12.5px] text-primary hover:underline"
          >
            <Plus className="h-3.5 w-3.5" /> Another size
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 text-[12px]">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground font-medium">Date</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-9 px-2 border rounded bg-background text-[13px]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground font-medium">Note</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={mode === "sort" ? "e.g. PUR-0012" : "Reason"}
              className="h-9 px-2 border rounded bg-background text-[13px]"
              aria-label="Note"
            />
          </label>
        </div>
        {mode === "remove" && (
          <label className="flex items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={scrap} onChange={(e) => setScrap(e.target.checked)} />
            These are scrap — book as Cutting wastage (expense)
          </label>
        )}
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12.5px]">
            Total:{" "}
            <b>
              {fmtLen(total)} {u}
            </b>
            {mode === "sort" && (
              <span className="text-muted-foreground"> of {fmtLen(loose)} unsorted</span>
            )}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
