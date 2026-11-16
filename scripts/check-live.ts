/**
 * READ-ONLY health check of the LIVE books — the same checks the monkey and
 * full-shop tests run after every step:
 *   npx esbuild scripts/check-live.ts --bundle --platform=node --format=cjs \
 *     --alias:@=./src --external:firebase-admin --outfile=node_modules/.cache/check-live.cjs
 *   node node_modules/.cache/check-live.cjs <service-account.json>
 */
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
import { planDataRepair } from "@/lib/dataRepair";
import { buildPostings, unbalancedDocs, balances, rupees, ACC } from "@/lib/postings";
import { buildFinancials } from "@/lib/financials";
import { netPartyPositions } from "@/lib/ledger";
import { ymd } from "@/lib/format";

initializeApp({ credential: cert(JSON.parse(readFileSync(process.argv[2], "utf8"))) });
const db = getFirestore();
const all = async <T>(c: string) =>
  (await db.collection(c).get()).docs.map((d) => ({ ...d.data(), id: d.id }) as T);

(async () => {
  const [
    parties,
    items,
    sales,
    purchases,
    saleReturns,
    purchaseReturns,
    expenses,
    banks,
    bankTxns,
    payments,
    stockAdjustments,
    cashAdjustments,
    journalVouchers,
    productions,
    accounts,
    finConfig,
  ] = await Promise.all(
    [
      "parties",
      "items",
      "sales",
      "purchases",
      "sale-returns",
      "purchase-returns",
      "expenses",
      "banks",
      "bankTxns",
      "payments",
      "stock-adjustments",
      "cash-adjustments",
      "journal-vouchers",
      "productions",
      "bs-accounts",
      "fin-config",
    ].map((c) => all<never>(c)),
  );
  const data = {
    parties,
    items,
    sales,
    purchases,
    saleReturns,
    purchaseReturns,
    expenses,
    banks,
    bankTxns,
    payments,
    stockAdjustments,
    cashAdjustments,
    journalVouchers,
    productions,
  } as never as Parameters<typeof buildPostings>[0] & Record<string, never[]>;
  const out: string[] = [];
  const plan = planDataRepair(data as never);
  const stock = plan.items.filter((c) => Math.abs(c.delta) >= 0.005);
  if (stock.length)
    out.push(`stock to fix: ${stock.map((c) => `${c.name} ${c.stored}→${c.correct}`).join("; ")}`);
  if (plan.bills.length) out.push(`${plan.bills.length} bills' bank amounts to fix`);
  if (plan.accounts.length)
    out.push(
      `bank balances to fix: ${plan.accounts.map((a) => `${a.name} ${a.stored}→${a.correct}`).join("; ")}`,
    );
  const books = buildPostings(data);
  const off = unbalancedDocs(books.postings);
  if (off.length) out.push(`${off.length} unbalanced documents`);
  const d = new Date();
  const fyStart = `${d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1}-04-01`;
  const fin = buildFinancials(
    {
      books,
      stock: data as never,
      parties: parties as never,
      banks: banks as never,
      accounts: accounts as never,
      config: (finConfig as never[])[0],
    },
    fyStart,
    ymd(d),
  );
  if (Math.abs(fin.difference) >= 0.01) out.push(`balance sheet difference ${fin.difference}`);
  const bal = balances(books.postings, ymd(d));
  for (const p of netPartyPositions(parties as never, data as never)) {
    const posted = rupees(bal.get(ACC.party(p.partyId)) ?? 0);
    if (Math.abs(p.net - posted) >= 0.011) out.push(`${p.name}: ${p.net} vs books ${posted}`);
  }
  console.log(
    `checked ${sales.length} sales, ${purchases.length} purchases, ${payments.length} payments, ${items.length} items`,
  );
  console.log(
    out.length
      ? "PROBLEMS:\n  " + out.join("\n  ")
      : "ALL GOOD — nothing to fix, books balance, balance sheet difference 0",
  );
  console.log(`net profit this FY: ${fin.netProfit}, total assets: ${fin.totalAssets}`);
  process.exit(0);
})().catch((e) => {
  console.error("FAILED", e?.stack ?? e);
  process.exit(1);
});
