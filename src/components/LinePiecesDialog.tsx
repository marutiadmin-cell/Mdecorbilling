/**
 * "✂ Pieces" on a bill line for a by-length item (slats, rails, rods):
 * what pieces the line is — "20 ft × 50, 10 ft × 10". The line's qty becomes
 * their total length; a purchase puts them straight into their sizes, a sale
 * takes exactly them (lib/pieces.ts). Clearing the rows leaves the line by
 * the foot (unsorted).
 */
import { useState } from "react";
import type { Item, LineItem, PieceCount } from "@/types";
import { piecesLength, sizeKey } from "@/lib/cutting";
import { fmtLen } from "@/lib/pieces";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NumInput } from "@/components/NumInput";
import { Plus, X } from "lucide-react";

export function LinePiecesDialog({
  line,
  item,
  onClose,
  onSave,
}: {
  line: LineItem | null;
  item: Item | undefined;
  onClose: () => void;
  onSave: (patch: { pieces: PieceCount[] | undefined; qty: number }) => void;
}) {
  const [rows, setRows] = useState<PieceCount[]>([]);
  const [forLine, setForLine] = useState<string | null>(null);
  if (line && forLine !== line.id) {
    setForLine(line.id);
    setRows(
      line.pieces?.length ? line.pieces : [{ length: item?.pieces?.barLength ?? 0, count: 0 }],
    );
  }
  if (!line && forLine) setForLine(null);
  if (!line || !item) return null;
  const u = item.unit;
  const live = rows
    .filter((r) => r.length > 0 && r.count > 0)
    .map((r) => ({ length: sizeKey(r.length), count: Math.floor(r.count) }));
  const total = piecesLength(live);
  const cls =
    "h-9 w-full px-2 border rounded bg-background text-[16px] sm:text-[13px] text-right outline-none focus:border-primary";
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pieces — {line.name}</DialogTitle>
        </DialogHeader>
        <p className="text-[12.5px] text-muted-foreground">
          What pieces this line is. The quantity becomes their total length, and they go straight
          into the item's sizes.
        </p>
        <div className="grid grid-cols-[1fr_1fr_32px] gap-2 text-[11px] font-semibold text-muted-foreground">
          <span>Length of each piece ({u})</span>
          <span>How many</span>
          <span />
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_32px] gap-2 items-center">
            <NumInput
              value={r.length}
              onValue={(n) => setRows((l) => l.map((x, j) => (j === i ? { ...x, length: n } : x)))}
              className={cls}
              aria-label="Line piece length"
            />
            <NumInput
              value={r.count}
              onValue={(n) => setRows((l) => l.map((x, j) => (j === i ? { ...x, count: n } : x)))}
              className={cls}
              aria-label="Line piece count"
            />
            <button
              type="button"
              onClick={() => setRows((l) => l.filter((_, j) => j !== i))}
              className="h-7 w-7 inline-flex items-center justify-center rounded text-gray-400 hover:text-rose-600 hover:bg-rose-50"
              title="Remove row"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setRows((l) => [...l, { length: 0, count: 0 }])}
          className="self-start h-8 px-2 inline-flex items-center gap-1 text-[12.5px] text-primary hover:underline"
        >
          <Plus className="h-3.5 w-3.5" /> Another size
        </button>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12.5px]">
            Total:{" "}
            <b>
              {fmtLen(total)} {u}
            </b>{" "}
            · {live.reduce((s, p) => s + p.count, 0)} pieces
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                onSave(
                  live.length ? { pieces: live, qty: total } : { pieces: undefined, qty: line.qty },
                )
              }
            >
              Use these pieces
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
