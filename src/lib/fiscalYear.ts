import { ymd, today } from "./format";

/** Indian financial year: 1 April – 31 March. `key` is the starting
 *  calendar year as a string, e.g. "2025" for 1 Apr 2025 – 31 Mar 2026
 *  ("FY 2025-26"). */
export interface FinancialYear {
  key: string;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  label: string; // "FY 2025-26"
}

/** Starting year of the FY containing this date — April onward belongs to
 *  this calendar year's FY, Jan–Mar belongs to the previous one. */
export function fyKeyOf(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date + "T00:00:00") : date;
  const y = d.getFullYear();
  return String(d.getMonth() >= 3 ? y : y - 1);
}

export function fyBounds(key: string): { from: string; to: string } {
  const y = Number(key);
  return { from: `${y}-04-01`, to: ymd(new Date(y + 1, 2, 31)) };
}

export function fyLabel(key: string): string {
  const y = Number(key);
  return `FY ${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

export function financialYearOf(key: string): FinancialYear {
  const { from, to } = fyBounds(key);
  return { key, from, to, label: fyLabel(key) };
}

export function currentFY(): FinancialYear {
  return financialYearOf(fyKeyOf(today()));
}

/** Dropdown options, most recent first — a flat lookback window from today,
 *  not derived from transaction history, so this never depends on repos
 *  being loaded (matches how Tally/Zoho populate their own year pickers). */
export function listFYs(past = 6, future = 1): FinancialYear[] {
  const curKey = Number(fyKeyOf(today()));
  const out: FinancialYear[] = [];
  for (let y = curKey + future; y >= curKey - past; y--) out.push(financialYearOf(String(y)));
  return out;
}

/** True if `date` (YYYY-MM-DD) falls inside the given FY. */
export function isInFY(date: string, key: string): boolean {
  const { from, to } = fyBounds(key);
  return date >= from && date <= to;
}
