import { forwardRef, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Billing-friendly numeric input:
 *  - shows EMPTY instead of a pre-filled 0 (no "delete the 0 first" annoyance)
 *  - no browser spinner arrows (plain text input with numeric keyboard)
 *  - select-all on focus so typing replaces the old value instantly
 *  - accepts only digits and one decimal point while typing ("0.5" works)
 */
export const NumInput = forwardRef<
  HTMLInputElement,
  {
    value: number;
    onValue: (n: number) => void;
    className?: string;
    placeholder?: string;
    /** Allow a leading minus (e.g. opening balance "you owe them") */
    allowNegative?: boolean;
  } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">
>(function NumInput(
  { value, onValue, className, placeholder = "0", allowNegative = false, ...rest },
  ref,
) {
  const [text, setText] = useState(value === 0 ? "" : String(value));
  const lastNum = useRef(value);
  /* How many keystrokes this box has sent up, and how many there had been
     when THIS render began. A render can begin, commit, and have its effect
     run only later — and if the person typed in between, that render's
     `value` is from BEFORE their keystroke. Re-syncing to it ate the
     keystroke: typing 750 into a payment amount saved 70, when a slow
     render (a big shop's party balance) straddled the "5". Found by the
     monkey test. A clamp is unaffected: it renders AFTER the keystroke. */
  const keystrokes = useRef(0);
  const keystrokesAtRender = keystrokes.current;

  // Re-sync display when the value differs from what was last typed (new
  // line added, "Full" button, clamping…). Runs on EVERY render — a clamp
  // that lands back on the previous prop value (e.g. Disc% typed 1000,
  // clamped to 100 which it already was) doesn't change the prop, so a
  // [value]-keyed effect would never fire and the box would keep showing
  // the unclamped text.
  // No dependency array ON PURPOSE (see above). The lastNum guard is what
  // stops this looping: setText only fires when the prop genuinely moved.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Typed into since this render began: its value is stale — the render
    // after the keystroke carries the right one and syncs then.
    if (keystrokesAtRender !== keystrokes.current) return;
    if (value !== lastNum.current) {
      setText(value === 0 ? "" : String(value));
      lastNum.current = value;
    }
  });

  return (
    <input
      ref={ref}
      type="text"
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        const t = e.target.value;
        const ok = allowNegative ? /^-?\d*\.?\d*$/.test(t) : /^\d*\.?\d*$/.test(t);
        if (!ok) return; // digits + at most one dot (+ optional leading minus)
        keystrokes.current++;
        setText(t);
        const n = parseFloat(t);
        lastNum.current = isNaN(n) ? 0 : n;
        onValue(lastNum.current);
      }}
      className={className}
      {...rest}
      onFocus={(e) => {
        e.target.select();
        rest.onFocus?.(e);
      }}
    />
  );
});

/** Labeled NumInput styled like the app's Field component — for dialog forms. */
export function NumField({
  label,
  value,
  onValue,
  allowNegative,
  placeholder,
  className,
}: {
  label?: string;
  value: number;
  onValue: (n: number) => void;
  allowNegative?: boolean;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-[12px]">
      {label && <span className="text-muted-foreground font-medium">{label}</span>}
      <NumInput
        value={value}
        onValue={onValue}
        allowNegative={allowNegative}
        placeholder={placeholder}
        className={cn(
          "h-8 px-2 border rounded bg-background outline-none focus:border-primary focus:ring-1 focus:ring-primary",
          className,
        )}
      />
    </label>
  );
}
