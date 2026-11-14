import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { matchesQuery, byRelevance } from "@/lib/search";
import { useHighlightScroll } from "@/hooks/useHighlightScroll";
import type { Item } from "@/types";
import { ItemDialog } from "@/routes/items";

const KIND_LABEL: Record<string, string> = { raw: "Raw", finished: "Finished" };

/**
 * Pick ONE existing item by typing part of its name.
 *
 * ComboInput is the right tool for a category, where anything new is fine;
 * it is the wrong one here, because a BOM or production line must point at a
 * real item by id — two items can share a name, and a typed name that matches
 * nothing must not quietly become a "new" material. So: same keyboard and
 * portal behaviour as ComboInput (see its comments for why the list portals
 * into the dialog), but the value is an item id. A typed name never becomes
 * an item by itself: with `allowAdd`, the last row "+ Add new item" opens
 * the Items page's own form (the one form for items across the app), and the
 * item it saves is chosen here. Leaving the box without choosing puts the
 * chosen item's name back.
 */
export function ItemPicker({
  value,
  onChange,
  items,
  placeholder = "Type to search items…",
  className,
  ariaLabel,
  autoFocus,
  allowAdd,
  newItemKind,
}: {
  /** The chosen item's id, or "" for none. */
  value: string;
  onChange: (item: Item) => void;
  items: Item[];
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  /** Offer "+ Add new item", opening the full item form. */
  allowAdd?: boolean;
  /** Item type the new item starts as (raw material, finished good). */
  newItemKind?: Item["kind"];
}) {
  const chosen = items.find((i) => i.id === value);
  const [text, setText] = useState(chosen?.name ?? "");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useHighlightScroll(listRef, idx, open);
  const inputRef = useRef<HTMLInputElement>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [rect, setRect] = useState<{
    position: "fixed" | "absolute";
    top: number;
    left: number;
    width: number;
  } | null>(null);

  // Follow the value when it changes from outside (a BOM chosen, a row reset).
  useEffect(() => {
    if (!open) setText(chosen?.name ?? "");
  }, [chosen?.name, open]);

  useEffect(() => {
    if (!open) return;
    const dialogEl = inputRef.current?.closest('[role="dialog"]') as HTMLElement | null;
    setPortalTarget(dialogEl ?? document.body);
    const update = () => {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const origin = dialogEl ? dialogEl.getBoundingClientRect() : { top: 0, left: 0 };
      const next = {
        position: (dialogEl ? "absolute" : "fixed") as "fixed" | "absolute",
        top: r.bottom - origin.top + 4,
        left: r.left - origin.left,
        width: Math.max(r.width, 260),
      };
      setRect((prev) =>
        prev &&
        prev.position === next.position &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.width === next.width
          ? prev
          : next,
      );
    };
    const onScroll = (e: Event) => {
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
  }, [open]);

  const typed = text.trim();
  // While the box still shows the chosen item's own name, list everything —
  // opening the picker to change a material should not show only itself.
  const searching = typed && typed !== chosen?.name;
  const rows = (
    searching
      ? items.filter((i) => matchesQuery(typed, i.name)).sort(byRelevance(typed, (i) => i.name))
      : [...items].sort((a, b) => a.name.localeCompare(b.name))
  ).slice(0, 60);

  const commit = (item: Item) => {
    onChange(item);
    setText(item.name);
    setOpen(false);
  };
  // The add row sits after the matches, so ↓/Enter reach it like any row.
  const exact = rows.some((i) => i.name.trim().toLowerCase() === typed.toLowerCase());
  const showAdd = !!allowAdd && !(searching && exact);
  const addIdx = rows.length;
  const startAdd = () => {
    setOpen(false);
    setAdding(searching ? typed : "");
  };

  return (
    <>
      <input
        ref={inputRef}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        autoFocus={autoFocus}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setIdx(0);
        }}
        // Open on focus only while nothing is chosen. A dialog focuses its
        // first field by itself, and Tab walks through every filled row —
        // a list springing open over the form each time hides what is being
        // edited. A click, typing, or ↓ still opens it.
        onFocus={(e) => {
          if (!chosen) setOpen(true);
          e.currentTarget.select();
        }}
        onClick={() => setOpen(true)}
        onBlur={() =>
          setTimeout(() => {
            setOpen(false);
            setText(chosen?.name ?? "");
          }, 150)
        }
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setIdx((i) => Math.min(rows.length - (showAdd ? 0 : 1), i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIdx((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && open && rows[idx]) {
            e.preventDefault();
            commit(rows[idx]);
          } else if (e.key === "Enter" && open && showAdd && idx === addIdx) {
            e.preventDefault();
            startAdd();
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className={className}
      />
      {open &&
        rect &&
        portalTarget &&
        createPortal(
          <div
            role="listbox"
            style={{
              position: rect.position,
              top: rect.top,
              left: rect.left,
              width: rect.width,
              pointerEvents: "auto",
            }}
            ref={listRef}
            className="z-50 border rounded-md bg-popover shadow-elevated max-h-60 overflow-auto"
          >
            {rows.length === 0 && !showAdd ? (
              <div className="px-2.5 py-2 text-[12px] text-muted-foreground">
                No item matches — add it on the Items page first
              </div>
            ) : (
              rows.map((it, i) => (
                <div
                  key={it.id}
                  data-opt={i}
                  role="option"
                  aria-selected={i === idx}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(it);
                  }}
                  onMouseEnter={() => setIdx(i)}
                  className={`px-2.5 py-1.5 text-[13px] cursor-pointer flex items-center gap-2 ${
                    i === idx ? "bg-accent" : "hover:bg-accent"
                  }`}
                >
                  <span className="truncate flex-1">{it.name}</span>
                  {it.kind && KIND_LABEL[it.kind] && (
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground border rounded px-1">
                      {KIND_LABEL[it.kind]}
                    </span>
                  )}
                  <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                    {Math.round((it.stock || 0) * 100) / 100} {it.unit}
                  </span>
                </div>
              ))
            )}
            {showAdd && (
              <div
                data-opt={addIdx}
                role="option"
                aria-selected={idx === addIdx}
                onMouseDown={(e) => {
                  e.preventDefault();
                  startAdd();
                }}
                onMouseEnter={() => setIdx(addIdx)}
                className={`px-2.5 py-1.5 text-[13px] cursor-pointer border-t text-primary font-medium ${
                  idx === addIdx ? "bg-accent" : "hover:bg-accent"
                }`}
              >
                + Add new item{searching ? ` "${typed}"` : ""}
              </div>
            )}
          </div>,
          portalTarget,
        )}
      {allowAdd && (
        <ItemDialog
          open={adding !== null}
          onOpenChange={(v) => {
            if (!v) setAdding(null);
          }}
          item={null}
          initialName={adding ?? undefined}
          initialKind={newItemKind}
          onSaved={() => {}}
          onCreated={(it) => {
            setAdding(null);
            commit(it);
          }}
        />
      )}
    </>
  );
}
