import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { useHighlightScroll } from "@/hooks/useHighlightScroll";

/**
 * A small dropdown that belongs to this app rather than to Windows.
 *
 * A native <select> hands its popup to the operating system, which draws a
 * plain list in the OS blue and ignores every radius, font and colour the
 * rest of the screen uses — a foreign control sitting in the middle of the
 * app. This is the same popup the account and category pickers use: rounded
 * card, the app's own accent for the highlight, a tick on the current choice.
 *
 * The popup is portalled and positioned with fixed/absolute viewport-aware
 * coordinates — this control is used inside scrollable/clipping containers
 * (a table with overflow-x-auto, a modal dialog) where a plain
 * absolutely-positioned popup gets cut off by its own ancestor instead of
 * floating above everything.
 *
 * WHERE it portals to matters as much as how it's positioned: a Radix
 * Dialog locks page scroll while open by intercepting wheel/touch
 * everywhere EXCEPT inside its own DOM subtree. A popup portalled straight
 * to <body> — a SIBLING of the dialog, not a descendant — renders fine and
 * even takes clicks fine (pointer-events is a separate mechanism), but
 * every wheel scroll over it gets silently swallowed by that same lock.
 * So when this control is opened from inside a dialog, it portals INSIDE
 * that dialog's own node instead, positioned relative to the dialog's own
 * box (a dialog is centered with a CSS transform, which makes it the
 * containing block for a fixed/absolute descendant, so "relative to the
 * dialog" is what position math has to use once it's nested there).
 *
 * It opens UPWARDS when there is no room below, which matters because the
 * places that need it most — a per-page control, a footer filter — live at
 * the bottom of the screen where a downward list would be cut off.
 */
export function SelectMenu<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  className = "",
  align = "left",
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
  className?: string;
  /** Which edge the popup lines up with — `right` for a control near the
   *  right edge, where a left-aligned popup would hang off the screen. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  /** Arrowing past the bottom edge used to move the highlight invisibly. */
  const listRef = useRef<HTMLDivElement>(null);
  useHighlightScroll(listRef, idx, open);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{
    position: "fixed" | "absolute";
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
    minWidth: number;
  } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const chosen = options.find((o) => o.value === value);

  // Decide the direction, the position, and WHERE to portal — all measured
  // fresh every time it opens (and on scroll/resize of anything, since a
  // nested scroll container — a modal, a scrollable table — moves the
  // trigger without the window itself scrolling). See the file comment for
  // why the portal target and the position math both depend on whether
  // this control lives inside a dialog.
  useEffect(() => {
    if (!open) return;
    const dialogEl = btnRef.current?.closest('[role="dialog"]') as HTMLElement | null;
    setPortalTarget(dialogEl ?? document.body);
    const update = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const originRect = dialogEl
        ? dialogEl.getBoundingClientRect()
        : { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
      const needed = Math.min(options.length * 34 + 8, 240);
      const up = r.bottom + needed > window.innerHeight && r.top > needed;
      const position: "fixed" | "absolute" = dialogEl ? "absolute" : "fixed";
      const vertical = up
        ? { bottom: originRect.bottom - r.top + 4 }
        : { top: r.bottom - originRect.top + 4 };
      const horizontal =
        align === "right" ? { right: originRect.right - r.right } : { left: r.left - originRect.left };
      const next = { position, ...vertical, ...horizontal, minWidth: r.width };
      // Scrolling the list's OWN content fires this too (scroll doesn't
      // bubble, but a capture listener on window still sees it) — recompute
      // only when something actually moved, or every tick of the user's own
      // scroll re-sets identical values and the popup visibly shakes.
      setPos((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    const onScroll = (e: Event) => {
      // The popup scrolling itself never needs to reposition the popup —
      // only an ANCESTOR of the trigger button moving does.
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return;
      update();
    };
    update();
    // Capture phase: "scroll" does not bubble, so a listener on window only
    // sees it for a nested scrollable ancestor if attached with capture.
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", update);
    };
  }, [open, options.length, align]);

  useEffect(() => {
    if (!open) return;
    setIdx(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The popup is portalled outside `ref`'s DOM subtree, so a click
      // inside it must not count as "outside" — that would close the menu
      // before the option's own click handler gets credit for the pick.
      if (ref.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Closes the LIST, not whatever the list is sitting inside.
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setIdx((i) => Math.min(options.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const picked = options[idx];
        if (picked) onChange(picked.value);
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, options, idx, onChange]);

  return (
    <div className="relative" ref={ref}>
      <button
        ref={btnRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`inline-flex items-center gap-1 rounded-md border bg-background text-left outline-none transition ${
          open ? "border-primary ring-1 ring-primary" : "border-input hover:bg-accent/40"
        } ${className}`}
      >
        <span className="tabular-nums">{chosen?.label ?? ""}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open &&
        pos &&
        portalTarget &&
        createPortal(
          <div
            role="listbox"
            aria-label={ariaLabel}
            ref={listRef}
            style={{
              position: pos.position,
              top: pos.top,
              bottom: pos.bottom,
              left: pos.left,
              right: pos.right,
              minWidth: pos.minWidth,
              maxHeight: 240,
              overflowY: "auto",
              // A modal Radix dialog sets pointer-events:none on <body>
              // while open; when this popup still portals to <body> (no
              // dialog ancestor found) it needs this to stay clickable.
              pointerEvents: "auto",
            }}
            className="z-50 border rounded-md bg-popover shadow-elevated py-1"
          >
            {options.map((o, i) => (
              <div
                key={String(o.value)}
                data-opt={i}
                role="option"
                aria-selected={o.value === value}
                onMouseEnter={() => setIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(o.value);
                  setOpen(false);
                }}
                className={`px-3 py-1.5 text-[13px] cursor-pointer flex items-center justify-between gap-3 whitespace-nowrap tabular-nums ${
                  i === idx ? "bg-accent" : ""
                }`}
              >
                {o.label}
                {o.value === value && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
              </div>
            ))}
          </div>,
          portalTarget,
        )}
    </div>
  );
}
