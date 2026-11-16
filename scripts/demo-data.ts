/**
 * Dummy data in the LIVE books — add it, count it, remove it.
 *
 *   npm run demo-data -- count  <service-account.json>
 *   npm run demo-data -- add    <service-account.json>
 *   npm run demo-data -- remove <service-account.json>
 *
 * The data is src/lib/demoData.ts in live form: every id starts "demo-",
 * every name says "Demo", every number ENDS "-DEMO" (the app's numbering
 * reads trailing digits only, so the shop's real invoice series never
 * jumps), and no GSTINs (nothing fake reaches a GST return). `remove`
 * deletes exactly the "demo-" documents in every collection — nothing else.
 *
 * settings/company is only FILLED IN where empty (Manufacturing settings,
 * expense categories); the shop's name, GSTIN, numbering are never touched,
 * and `remove` leaves those settings in place.
 */
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
import { buildDemoShop, type DemoShop } from "@/lib/demoData";

const COLLECTIONS: [string, keyof DemoShop][] = [
  ["banks", "banks"],
  ["items", "items"],
  ["parties", "parties"],
  ["payees", "payees"],
  ["bs-accounts", "bsAccounts"],
  ["boms", "boms"],
  ["sales", "sales"],
  ["purchases", "purchases"],
  ["payments", "payments"],
  ["sale-returns", "saleReturns"],
  ["purchase-returns", "purchaseReturns"],
  ["expenses", "expenses"],
  ["cash-adjustments", "cashAdjustments"],
  ["bankTxns", "bankTxns"],
  ["journal-vouchers", "journals"],
  ["stock-adjustments", "stockAdjustments"],
  ["estimates", "estimates"],
  ["productions", "productions"],
  ["piece-sorts", "pieceSorts"],
];
/** Everything the app stores per record — removal looks in all of them. */
const ALL = [...COLLECTIONS.map(([c]) => c), "business-docs", "fin-config"];

const [, , cmd, keyPath, flag] = process.argv;
/** --plain: real-looking names and numbers (no "Demo"/"-DEMO") for a
 *  database that will be wiped before the shop goes live. */
const PLAIN = flag === "--plain";
if (!["count", "add", "remove"].includes(cmd ?? "") || !keyPath) {
  console.error("usage: demo-data <count|add|remove> <service-account.json>");
  process.exit(2);
}
const key = JSON.parse(readFileSync(keyPath, "utf8"));
initializeApp({ credential: cert(key) });
const db = getFirestore(); // the "(default)" database, as the app uses
db.settings({ ignoreUndefinedProperties: true });

const demoIdsIn = async (collection: string) =>
  (
    await db
      .collection(collection)
      .where(FieldPath.documentId(), ">=", "demo-")
      .where(FieldPath.documentId(), "<", "demo.")
      .select()
      .get()
  ).docs.map((d) => d.ref);

async function count() {
  let total = 0;
  for (const c of ALL) {
    const n = (await demoIdsIn(c)).length;
    if (n) console.log(`  ${c}: ${n}`);
    total += n;
  }
  console.log(`demo documents in the live books: ${total}`);
  return total;
}

async function add() {
  if ((await count()) > 0) {
    console.error("Demo data is already there — remove it first. Nothing written.");
    process.exit(1);
  }
  // Continue every number series after what the books already hold, so a
  // dummy INV-0001 never sits beside a real one.
  const SERIES: [string, string][] = [
    ["sales", "INV-"],
    ["purchases", "PUR-"],
    ["sale-returns", "SR-"],
    ["purchase-returns", "PR-"],
    ["productions", "MFG-"],
    ["journal-vouchers", "JV-"],
  ];
  const numberFrom: Record<string, number> = {};
  const maxIn = async (collection: string, prefix?: string) => {
    let max = 0;
    for (const d of (await db.collection(collection).select("number").get()).docs) {
      const n = String(d.get("number") ?? "");
      if (prefix && !n.startsWith(prefix)) continue;
      const m = /(\d+)\s*$/.exec(n);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max;
  };
  for (const [c, prefix] of SERIES) numberFrom[prefix] = await maxIn(c);
  numberFrom["QT-"] = await maxIn("estimates", "QT-");
  numberFrom["PF-"] = await maxIn("estimates", "PF-");
  console.log("numbering continues after:", JSON.stringify(numberFrom));

  const shop = buildDemoShop({ live: true, plain: PLAIN, numberFrom });

  // The app refuses two items (or parties) with one name — keep it so.
  for (const [collection, k] of [
    ["items", "items"],
    ["parties", "parties"],
  ] as const) {
    const taken = new Set(
      (await db.collection(collection).select("name").get()).docs.map((d) =>
        String(d.get("name") ?? "")
          .trim()
          .toLowerCase(),
      ),
    );
    for (const rec of shop[k] as { name: string }[])
      while (taken.has(rec.name.trim().toLowerCase())) rec.name = `${rec.name} (2)`;
  }
  let written = 0;
  for (const [collection, k] of COLLECTIONS) {
    const list = shop[k] as unknown as { id: string }[];
    for (let i = 0; i < list.length; i += 400) {
      const batch = db.batch();
      for (const rec of list.slice(i, i + 400)) {
        if (!rec.id.startsWith("demo-"))
          throw new Error(`refusing to write a non-demo id: ${rec.id}`);
        batch.set(db.collection(collection).doc(rec.id), rec);
      }
      await batch.commit();
      written += Math.min(400, list.length - i);
    }
    console.log(`  ${collection}: ${list.length}`);
  }

  // settings/company: fill in, never replace.
  const ref = db.collection("settings").doc("company");
  const company = (await ref.get()).data() ?? {};
  const mine = (company.mtm ?? {}) as Record<string, unknown>;
  const constants = [...((mine.constants as { key: string }[] | undefined) ?? [])];
  for (const c of shop.mtm.constants ?? [])
    if (!constants.some((x) => x.key === c.key)) constants.push(c);
  const cats: string[] = [...((company.expenseCategories as string[] | undefined) ?? [])];
  for (const c of shop.expenseCategories)
    if (!cats.some((x) => x.toLowerCase() === c.toLowerCase())) cats.push(c);
  const filled = Object.fromEntries(
    Object.entries(mine).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)),
  );
  await ref.set(
    { mtm: { ...shop.mtm, ...filled, constants }, expenseCategories: cats },
    { merge: true },
  );
  console.log(`written: ${written} demo documents; Manufacturing settings filled in where empty`);
}

async function remove() {
  let removed = 0;
  for (const c of [...ALL].reverse()) {
    const refs = await demoIdsIn(c);
    for (let i = 0; i < refs.length; i += 400) {
      const batch = db.batch();
      refs.slice(i, i + 400).forEach((r) => batch.delete(r));
      await batch.commit();
    }
    if (refs.length) console.log(`  ${c}: removed ${refs.length}`);
    removed += refs.length;
  }
  console.log(`removed: ${removed} demo documents (only ids starting "demo-")`);
}

(cmd === "count" ? count() : cmd === "add" ? add() : remove()).then(
  () => process.exit(0),
  (e) => {
    console.error("FAILED:", e?.message ?? e);
    process.exit(1);
  },
);
