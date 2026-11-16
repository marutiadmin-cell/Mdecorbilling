/**
 * Does the whole book agree with itself? The checks the monkey test and the
 * full-shop test run — returned as plain sentences, empty when all is well.
 *
 *  - Settings → Fix calculations would change nothing (stock, bank-paid
 *    amounts, bank balances);
 *  - every document's postings balance, and the balance sheet difference is 0;
 *  - each party's balance on its own screen equals what the books post;
 *  - no bill is paid below zero or above its total.
 */
import { planDataRepair } from "@/lib/dataRepair";
import { buildPostings, unbalancedDocs, balances, rupees, ACC } from "@/lib/postings";
import { buildFinancials } from "@/lib/financials";
import { booksData, finInputFromRepos } from "@/lib/finData";
import { netPartyPositions } from "@/lib/ledger";
import { ymd } from "@/lib/format";
import {
  ItemRepo,
  PartyRepo,
  ProductionRepo,
  PurchaseRepo,
  SalesRepo,
  PaymentRepo,
  ExpenseRepo,
  BankRepo,
  BankTxnRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  StockAdjustmentRepo,
  JournalVoucherRepo,
} from "@/repositories";

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function bookProblems(): string[] {
  const out: string[] = [];
  const plan = planDataRepair({
    sales: SalesRepo.all(),
    purchases: PurchaseRepo.all(),
    payments: PaymentRepo.all(),
    banks: BankRepo.all(),
    bankTxns: BankTxnRepo.all(),
    expenses: ExpenseRepo.all(),
    items: ItemRepo.all(),
    saleReturns: SaleReturnRepo.all(),
    purchaseReturns: PurchaseReturnRepo.all(),
    stockAdjustments: StockAdjustmentRepo.all(),
    productions: ProductionRepo.all(),
    journalVouchers: JournalVoucherRepo.all(),
  });
  const stock = plan.items.filter((c) => Math.abs(num(c.delta)) >= 0.005);
  if (stock.length)
    out.push(
      `Fix calculations would correct stock: ${stock
        .slice(0, 5)
        .map((c) => `${c.name} ${c.stored}→${c.correct}`)
        .join("; ")}`,
    );
  if (plan.bills.length)
    out.push(`Fix calculations would correct ${plan.bills.length} bills' bank amounts`);
  if (plan.accounts.length)
    out.push(
      `Fix calculations would correct bank balances: ${plan.accounts.map((a) => `${a.name} ${a.stored}→${a.correct}`).join("; ")}`,
    );

  const books = buildPostings(booksData());
  const off = unbalancedDocs(books.postings);
  if (off.length)
    out.push(
      `${off.length} documents' postings do not balance: ${JSON.stringify(off.slice(0, 3))}`,
    );
  const d = new Date();
  const fyStart = `${d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1}-04-01`;
  const fin = buildFinancials(finInputFromRepos(), fyStart, ymd(d));
  if (Math.abs(fin.difference) >= 0.01) out.push(`balance sheet difference is ${fin.difference}`);

  const bal = balances(books.postings, ymd(d));
  for (const pos of netPartyPositions(PartyRepo.all(), {
    sales: SalesRepo.all(),
    purchases: PurchaseRepo.all(),
    saleReturns: SaleReturnRepo.all(),
    purchaseReturns: PurchaseReturnRepo.all(),
    payments: PaymentRepo.all(),
    journalVouchers: JournalVoucherRepo.all(),
  })) {
    const posted = rupees(bal.get(ACC.party(pos.partyId)) ?? 0);
    if (Math.abs(pos.net - posted) >= 0.011)
      out.push(`${pos.name}: its balance says ${pos.net}, the books say ${posted}`);
  }
  for (const inv of [...SalesRepo.all(), ...PurchaseRepo.all()])
    if (num(inv.paid) < -0.005 || num(inv.paid) > num(inv.total) + 0.011)
      out.push(`${inv.number}: paid ${inv.paid} of ${inv.total}`);
  return out;
}
