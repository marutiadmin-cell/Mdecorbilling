/**
 * Everything the financial statements read, gathered from the live
 * repositories in one place — so the Balance Sheet and its Setup page can
 * never build the books from different data.
 */
import {
  BankRepo,
  BankTxnRepo,
  BsAccountRepo,
  CashAdjustmentRepo,
  ExpenseRepo,
  FinConfigRepo,
  ItemRepo,
  JournalVoucherRepo,
  PartyRepo,
  PaymentRepo,
  ProductionRepo,
  PurchaseRepo,
  PurchaseReturnRepo,
  SaleReturnRepo,
  SalesRepo,
  StockAdjustmentRepo,
} from "@/repositories";
import { buildPostings, type BooksData } from "@/lib/postings";
import { averageCosts, type StockData } from "@/lib/stockValuation";
import type { FinInput } from "@/lib/financials";

export const FIN_CONFIG_ID = "config";

export function booksData(): BooksData & StockData {
  return {
    parties: PartyRepo.all(),
    banks: BankRepo.all(),
    sales: SalesRepo.all(),
    purchases: PurchaseRepo.all(),
    saleReturns: SaleReturnRepo.all(),
    purchaseReturns: PurchaseReturnRepo.all(),
    payments: PaymentRepo.all(),
    expenses: ExpenseRepo.all(),
    cashAdjustments: CashAdjustmentRepo.all(),
    bankTxns: BankTxnRepo.all(),
    journalVouchers: JournalVoucherRepo.all(),
    items: ItemRepo.all(),
    stockAdjustments: StockAdjustmentRepo.all(),
    productions: ProductionRepo.all(),
  };
}

export function finInputFromRepos(): FinInput {
  const data = booksData();
  return {
    books: buildPostings(data),
    stock: data,
    parties: data.parties,
    banks: data.banks,
    accounts: BsAccountRepo.all(),
    config: FinConfigRepo.get(FIN_CONFIG_ID),
  };
}

/** Current weighted-average cost of every item, from the live books. */
export function averageCostMap(): Map<string, number> {
  return averageCosts(booksData());
}

/** An item's cost: its weighted average, or — for an item with no history at
 *  all yet — the purchase price typed on it. */
export function costOf(map: Map<string, number>, item: { id: string; purchasePrice?: number }) {
  const avg = map.get(item.id);
  return avg !== undefined && avg > 0 ? avg : (item.purchasePrice ?? 0);
}

/** What an item's stock is worth at its average cost. An item oversold below
 *  zero is worth nothing — the same rule the balance sheet follows, so every
 *  stock-value figure in the app agrees with it. */
export function stockValueOf(
  map: Map<string, number>,
  item: { id: string; stock?: number; purchasePrice?: number },
): number {
  return Math.round(Math.max(0, item.stock ?? 0) * costOf(map, item) * 100) / 100;
}
