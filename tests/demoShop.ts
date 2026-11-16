/**
 * The dummy M Décor (src/lib/demoData.ts) loaded into the TEST browser's
 * in-memory shop — the screen-test harness has no route to the live
 * Firestore (tests/stubs/firebase.ts). Same generator as Settings → Demo
 * data, in test form: the original ids and names (no "demo-"/"Demo"), a few
 * deliberately messy records, GSTINs, and a test company.
 */
import {
  PartyRepo,
  ItemRepo,
  SalesRepo,
  PurchaseRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  ExpenseRepo,
  PayeeRepo,
  BankRepo,
  BankTxnRepo,
  PaymentRepo,
  CompanyRepo,
  StockAdjustmentRepo,
  EstimateRepo,
  CashAdjustmentRepo,
  BomRepo,
  ProductionRepo,
  BsAccountRepo,
  FinConfigRepo,
  JournalVoucherRepo,
} from "@/repositories";
import { buildDemoShop } from "@/lib/demoData";

export interface DemoCounts {
  items: number;
  parties: number;
  sales: number;
  purchases: number;
  payments: number;
  expenses: number;
  returns: number;
  estimates: number;
  journals: number;
  productions: number;
  boms: number;
}

export function seedDemoShop(opts: { scale?: number; seed?: number } = {}): DemoCounts {
  const shop = buildDemoShop({ ...opts, live: false });
  CompanyRepo.save({
    name: "M DÉCOR",
    gstin: "24AAACC1234D1ZI",
    phone: "9558945607",
    address: "Ring Road, Surat",
    currency: "INR",
    invoicePrefix: "INV-",
    purchasePrefix: "PUR-",
    enableGst: true,
    allowNegativeStock: true,
    expenseCategories: shop.expenseCategories,
    units: ["PCS", "MTR", "FT", "SQFT", "SET", "ROLL", "KG"],
    mtm: shop.mtm,
  } as never);
  const put = <T>(repo: { add: (x: never) => unknown }, list: T[]) =>
    list.forEach((x) => repo.add(x as never));
  put(BankRepo, shop.banks);
  put(ItemRepo, shop.items);
  put(PartyRepo, shop.parties);
  put(PayeeRepo, shop.payees);
  put(BsAccountRepo, shop.bsAccounts);
  put(BomRepo, shop.boms);
  put(SalesRepo, shop.sales);
  put(PurchaseRepo, shop.purchases);
  put(PaymentRepo, shop.payments);
  put(SaleReturnRepo, shop.saleReturns);
  put(PurchaseReturnRepo, shop.purchaseReturns);
  put(ExpenseRepo, shop.expenses);
  put(CashAdjustmentRepo, shop.cashAdjustments);
  put(BankTxnRepo, shop.bankTxns);
  put(JournalVoucherRepo, shop.journals);
  put(StockAdjustmentRepo, shop.stockAdjustments);
  put(EstimateRepo, shop.estimates);
  put(ProductionRepo, shop.productions);
  FinConfigRepo.add({
    id: "config",
    expenseClass: { Freight: "direct", "Karigar wages": "direct" },
    createdAt: "2025-01-01T00:00:00Z",
  } as never);
  return {
    items: shop.items.length,
    parties: shop.parties.length,
    sales: shop.sales.length,
    purchases: shop.purchases.length,
    payments: shop.payments.length,
    expenses: shop.expenses.length,
    returns: shop.saleReturns.length + shop.purchaseReturns.length,
    estimates: shop.estimates.length,
    journals: shop.journals.length,
    productions: shop.productions.length,
    boms: shop.boms.length,
  };
}
