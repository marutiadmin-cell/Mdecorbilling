import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { matchesQuery, byRelevance } from "@/lib/search";
import { Plus } from "lucide-react";
import { useHighlightScroll } from "@/hooks/useHighlightScroll";

/**
 * A text box that suggests what has been typed here before, and still accepts
 * anything new.
 *
 * Category was a plain input on both the item form and the bulk grid, so the
 * same shelf got entered as "Charger", "charger" and "Chargers" and the
 * category filter stopped meaning anything. Offering the existing values
 * makes the consistent choice the easy one, without ever blocking a genuinely
 * new one — which is why the free text stays and "add" is just the last row
 * of the list rather than a separate mode.
 *
 * The list is PORTALLED and positioned fixed, because this is used inside the
 * bulk grid's scroll container where an absolutely positioned dropdown would
 * be clipped by the row — the same reason the item picker does it.
 */
export function ComboInput({
  value,
  onValue,
  options,
  placeholder,
  className,
  ariaLabel,
  id,
}: {
  value: string;
  onValue: (v: string) => void;
  /** Existing values to suggest. Deduped and sorted by the caller or not —
   *  this dedupes case-insensitively either way. */
  options: string[];
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  /** Arrowing past the bottom edge used to move the highlight invisibly. */
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

  // WHERE this portals to matters, not just its coordinates: a Radix Dialog
  // locks page scroll while open by intercepting wheel/touch everywhere
  // EXCEPT inside its own DOM subtree. A popup portalled straight to
  // <body> — a sibling of the dialog, not a descendant — renders and even
  // takes clicks fine (pointer-events is a separate mechanism below), but
  // every wheel scroll over it gets silently swallowed by that same lock.
  // So from inside a dialog this portals INSIDE the dialog's own node
  // instead, positioned relative to the dialog's own box (it's centered
  // with a CSS transform, which makes it the containing block for a
  // fixed/absolute descendant once nested there).
  useEffect(() => {
    if (!open) return;
    const dialogEl = inputRef.current?.closest('[role="dialog"]') as HTMLElement | null;
    setPortalTarget(dialogEl ?? document.body);
    const update = () => {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const originRect = dialogEl ? dialogEl.getBoundingClientRect() : { top: 0, left: 0 };
      const next = {
        position: (dialogEl ? "absolute" : "fixed") as "fixed" | "absolute",
        top: r.bottom - originRect.top + 4,
        left: r.left - originRect.left,
        width: Math.max(r.width, 180),
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
      // The popup scrolling itself never needs to reposition the popup —
      // only an ANCESTOR of the trigger input moving does. Without this
      // guard, scroll doesn't bubble but IS seen here via the capture
      // listener below, so scrolling the list re-sets identical coordinates
      // on every tick and the popup visibly shakes.
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

  const unique = Array.from(
    new Map(
      options
        .map((o) => (o ?? "").trim())
        .filter(Boolean)
        .map((o) => [o.toLowerCase(), o]),
    ).values(),
  ).sort((a, b) => a.localeCompare(b));

  const typed = value.trim();
  const matches = typed
    ? unique.filter((o) => matchesQuery(typed, o)).sort(byRelevance(typed, (o) => o))
    : unique;
  // Only offer "add" for something genuinely absent — otherwise every
  // keystroke ends with a row inviting a duplicate of what already exists.
  const canAdd = !!typed && !unique.some((o) => o.toLowerCase() === typed.toLowerCase());
  const rows = canAdd ? [...matches, null] : matches;

  const commit = (v: string) => {
    onValue(v);
    setOpen(false);
  };

  return (
    <>
      <input
        ref={inputRef}
        id={id}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onValue(e.target.value);
          setOpen(true);
          setIdx(0);
        }}
        /* Select what is there, so arriving by CLICK behaves the way
           arriving by Tab already did.
           Reported from the shop as "clicking the category does nothing, only
           Tab works". Both focus the box; the difference is that Tab selects
           the contents and a click drops the caret wherever the pointer
           landed. Typing then inserts into the middle of the existing
           category — "Chaacrger" — the list matches nothing, and the box
           looks broken. Every other focus move in this app already selects
           (see useFormKeys); this one did not. */
        onFocus={(e) => {
          setOpen(true);
          e.currentTarget.select();
        }}
        // A click on a row must land before the blur closes the list, which
        // is what the delay buys; the rows also use mousedown for the same
        // reason.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setIdx((i) => Math.min(rows.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIdx((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && open && rows.length) {
            e.preventDefault();
            commit(rows[idx] ?? typed);
          } else if (e.key === "Escape" && open) {
            // Swallow it: this closes the list, it does not close the dialog
            // the list is sitting in.
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
        rows.length > 0 &&
        createPortal(
          /* pointerEvents: "auto" below is not decoration.
             A modal Radix dialog sets pointer-events:none on <body> while it
             is open; when no dialog ancestor was found above, this still
             portals to <body> and inherits that, becoming unclickable while
             the keyboard, which does not consult pointer-events at all,
             keeps working perfectly. That is the exact shape of the bug the
             shop reported twice: "clicking a category does nothing, only Tab
             works". It also hid from every test here, because dispatchEvent
             ignores pointer-events too. Only elementFromPoint asks the
             question a mouse actually asks, and that is what the test now
             uses. */
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
            className="z-50 border rounded-md bg-popover shadow-elevated max-h-56 overflow-auto"
          >
            {rows.map((opt, i) => (
              <div
                key={opt ?? "__add__"}
                data-opt={i}
                role="option"
                aria-selected={i === idx}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(opt ?? typed);
                }}
                onMouseEnter={() => setIdx(i)}
                className={`px-2.5 py-1.5 text-[13px] cursor-pointer flex items-center gap-1.5 ${
                  i === idx ? "bg-accent" : "hover:bg-accent"
                } ${opt === null ? "text-primary font-medium border-t" : ""}`}
              >
                {opt === null ? (
                  <>
                    <Plus className="h-3.5 w-3.5 shrink-0" />
                    Add &ldquo;{typed}&rdquo;
                  </>
                ) : (
                  opt
                )}
              </div>
            ))}
          </div>,
          portalTarget,
        )}
    </>
  );
}
