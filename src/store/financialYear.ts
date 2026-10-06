import { create } from "zustand";
import { currentFY, financialYearOf, listFYs, type FinancialYear } from "@/lib/fiscalYear";

const FY_KEY = "bz.financialYear";

const initialKey = (() => {
  if (typeof window === "undefined") return currentFY().key;
  try {
    return localStorage.getItem(FY_KEY) || currentFY().key;
  } catch {
    return currentFY().key;
  }
})();

interface FYState {
  fyKey: string;
  setFYKey: (key: string) => void;
}

const useFinancialYearStore = create<FYState>((set) => ({
  fyKey: initialKey,
  setFYKey: (key) => {
    set({ fyKey: key });
    try {
      localStorage.setItem(FY_KEY, key);
    } catch {
      // Private browsing blocks localStorage — the choice just won't
      // persist across a reload, same tradeoff as the sidebar's toggle.
    }
  },
}));

/** Only the FY *key* is persisted — never the computed from/to — so a stale
 *  stored range can never drift out of sync with what fyBounds() computes
 *  today. */
export function useFinancialYear(): FinancialYear & {
  setFY: (key: string) => void;
  options: FinancialYear[];
} {
  const fyKey = useFinancialYearStore((s) => s.fyKey);
  const setFYKey = useFinancialYearStore((s) => s.setFYKey);
  const fy = financialYearOf(fyKey);
  return { ...fy, setFY: setFYKey, options: listFYs() };
}
