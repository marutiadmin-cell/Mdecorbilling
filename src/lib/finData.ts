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
import type { StockData } from "@/lib/stockValuation";
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
