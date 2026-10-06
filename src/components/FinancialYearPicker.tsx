import { SelectMenu } from "@/components/SelectMenu";
import { useFinancialYear } from "@/store/financialYear";

/** Global Financial Year selector — Topbar (desktop) and Sidebar drawer
 *  (mobile). Changing it re-scopes the smart default date range on every
 *  report/list that already filters by date; it never discards a range
 *  someone has typed by hand (see each page's own "follow until diverged"
 *  effect). */
export function FinancialYearPicker({ className = "" }: { className?: string }) {
  const { key, options, setFY } = useFinancialYear();

  return (
    <SelectMenu
      value={key}
      options={options.map((fy) => ({ value: fy.key, label: fy.label }))}
      onChange={setFY}
      ariaLabel="Financial Year"
      className={`h-8 px-2.5 text-[12px] font-semibold ${className}`}
    />
  );
}
