/**
 * Every page, with a whole dummy shop's data — `npm run test:fullshop`.
 *
 * tests/demoShop.ts fills the TEST browser with ~two years of an M Décor-like
 * business (hundreds of items, parties, bills, payments, returns, expenses,
 * journals, quotations, BOMs incl. made-to-measure, production runs). Then
 * every route is opened — lists, detail pages, edit forms, new forms, owner
 * pages — and every tab inside them, checking that nothing:
 *   - crashes ("This page didn't load"), or logs a console error,
 *   - shows NaN / undefined / Infinity / Invalid Date / [object Object],
 *   - is slow with real volume (render time is reported, > 3 s fails),
 * and finally that the books agree with themselves (Fix calculations has
 * nothing to do; postings balance; balance-sheet difference 0; each party's
 * balance = the books).
 */
import { createRoot, type Root } from "react-dom/client";
import { act, type ReactNode } from "react";
import { createRouter, createMemoryHistory, RouterProvider, Outlet } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "@/routeTree.gen";
import { seedDemoShop } from "./demoShop";
import { bookProblems } from "./books";
import {
  SalesRepo,
  PurchaseRepo,
  ItemRepo,
  PartyRepo,
  PayeeRepo,
  BankRepo,
  EstimateRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  JobCardRepo,
} from "@/repositories";

export interface Results {
  passed: number;
  failed: number;
  fails: string[];
}
const R: Results = { passed: 0, failed: 0, fails: [] };
const info: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) R.passed++;
  else {
    R.failed++;
    if (R.fails.length < 120) R.fails.push(msg);
  }
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let currentPage = "";
const consoleErrors: string[] = [];

async function open(path: string): Promise<{ text: string; ms: number }> {
  currentPage = path;
  const router = createRouter({
    routeTree,
    context: { queryClient: new QueryClient() },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const t0 = performance.now();
  await router.load();
  if (root) root.unmount();
  if (host) host.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<RouterProvider router={router} />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 80));
  });
  const ms = Math.round(performance.now() - t0);
  return { text: host.textContent ?? "", ms };
}

/** Words that mean a number or a date went wrong on its way to the screen. */
const BAD: [RegExp, string][] = [
  [/\bNaN\b/, "NaN"],
  [/\bundefined\b/, "undefined"],
  [/\bInfinity\b/, "Infinity"],
  [/Invalid Date/, "Invalid Date"],
  [/\[object Object\]/, "[object Object]"],
  [/This page didn't load/, "the page crashed"],
];

function checkText(where: string, text: string) {
  for (const [re, label] of BAD) {
    const m = re.exec(text);
    if (m) {
      const at = Math.max(0, m.index - 60);
      assert(
        false,
        `${where}: shows ${label} — "…${text.slice(at, m.index + 40).replace(/\s+/g, " ")}…"`,
      );
      return;
    }
  }
  R.passed++;
}

async function visit(path: string, label = path) {
  const before = consoleErrors.length;
  let text = "";
  let ms = 0;
  try {
    ({ text, ms } = await open(path));
  } catch (e) {
    assert(false, `${label}: threw while opening — ${(e as Error)?.message}`);
    return;
  }
  assert(text.trim().length > 20, `${label}: rendered (almost) nothing`);
  checkText(label, text);
  assert(ms < 3000, `${label}: took ${ms} ms to open with a full shop's data`);
  info.push(`${label} ${ms}ms`);

  // Every tab on the page, too.
  const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).filter(
    (t) => t.offsetParent !== null,
  );
  for (const t of tabs.slice(0, 12)) {
    const name = (t.textContent ?? "").trim().slice(0, 30);
    await act(async () => {
      t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      t.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    checkText(`${label} › tab "${name}"`, host?.textContent ?? "");
  }
  const errs = consoleErrors.slice(before);
  assert(errs.length === 0, `${label}: console errors — ${errs.slice(0, 2).join(" | ")}`);
}

export async function run(): Promise<Results> {
  try {
    const rootOptions = (routeTree as unknown as { options: Record<string, unknown> }).options;
    rootOptions.component = function TestRoot() {
      return <Outlet />;
    };
    rootOptions.shellComponent = ({ children }: { children: ReactNode }) => <>{children}</>;
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    globalThis.__TEST_IS_OWNER__ = true;
    window.confirm = () => false;

    const origError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      const text = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
      if (!/not wrapped in act|configured to support act/.test(text))
        consoleErrors.push(`[${currentPage}] ${text.slice(0, 200)}`);
      origError(...args);
    };

    const t0 = performance.now();
    const counts = seedDemoShop({
      scale: Number((globalThis as { __SHOP_SCALE__?: number }).__SHOP_SCALE__ ?? 1),
    });
    info.push(`seeded in ${Math.round(performance.now() - t0)} ms: ${JSON.stringify(counts)}`);

    // Before anything is opened: the dummy shop itself is consistent.
    for (const p of bookProblems()) assert(false, `seeded books: ${p}`);

    const lists = [
      "/",
      "/sales",
      "/purchase",
      "/sale-return",
      "/purchase-return",
      "/payments",
      "/expenses",
      "/payees",
      "/parties",
      "/items",
      "/inventory",
      "/boms",
      "/productions",
      "/job-cards",
      "/quotations",
      "/proforma",
      "/bank",
      "/cash",
      "/daybook",
      "/journal-vouchers",
      "/gst",
      "/reports",
      "/financials",
      "/balance-sheet-setup",
      "/settings",
      "/documents",
      "/sales/new",
      "/purchase/new",
      "/sale-return/new",
      "/purchase-return/new",
    ];
    for (const p of lists) await visit(p);

    // Detail pages — a few of each, chosen to include the awkward ones.
    const sales = SalesRepo.all();
    const pickSome = <T,>(a: T[], f: (x: T) => boolean, n = 2) => a.filter(f).slice(0, n);
    for (const s of [
      ...pickSome(sales, (x) => !!x.paidSplits),
      ...pickSome(sales, (x) => x.paymentMode === "credit"),
      ...pickSome(sales, (x) => !x.gstEnabled, 1),
    ]) {
      await visit(`/sales/${s.id}`, `sale ${s.number}`);
      await visit(`/sales/edit/${s.id}`, `edit sale ${s.number}`);
    }
    for (const p of PurchaseRepo.all().slice(0, 2)) {
      await visit(`/purchase/${p.id}`, `purchase ${p.number}`);
      await visit(`/purchase/edit/${p.id}`, `edit purchase ${p.number}`);
    }
    for (const r of SaleReturnRepo.all().slice(0, 1))
      await visit(`/sale-return/${r.id}`, `sale return ${r.number}`);
    for (const r of PurchaseReturnRepo.all().slice(0, 1))
      await visit(`/purchase-return/${r.id}`, `purchase return ${r.number}`);
    const items = ItemRepo.all();
    for (const it of [
      ...items.filter((i) => ["DB-BLIND", "DB-SLT", "DS-SOFA3"].includes(i.id)),
      ...items.filter((i) => i.name === "Old Stock Lot (imported)"),
    ])
      await visit(`/items/${it.id}`, `item "${it.name}"`);
    for (const p of [
      ...PartyRepo.all()
        .filter((x) => (x.openingBalance ?? 0) < 0)
        .slice(0, 1),
      ...PartyRepo.all()
        .filter((x) => x.type === "customer")
        .slice(0, 1),
    ])
      await visit(`/parties/${p.id}`, `party "${p.name}"`);
    for (const p of PayeeRepo.all().slice(0, 1))
      await visit(`/payees/${p.id}`, `payee "${p.name}"`);
    for (const b of BankRepo.all()) await visit(`/bank/${b.id}`, `bank "${b.name}"`);
    for (const e of [
      ...EstimateRepo.all()
        .filter((x) => x.kind === "quotation")
        .slice(0, 1),
      ...EstimateRepo.all()
        .filter((x) => x.kind === "proforma")
        .slice(0, 1),
    ])
      await visit(
        `/${e.kind === "quotation" ? "quotations" : "proforma"}/${e.id}`,
        `${e.kind} ${e.number}`,
      );

    // A job card, and a blind order with measured windows.
    for (const c of JobCardRepo.all().slice(0, 2))
      await visit(`/job-cards/${c.id}`, `job card ${c.number}`);
    for (const e of EstimateRepo.all()
      .filter((x) => x.lineItems.some((l) => l.size))
      .slice(0, 1))
      await visit(
        `/${e.kind === "quotation" ? "quotations" : "proforma"}/${e.id}`,
        `blind order ${e.number}`,
      );

    // Opening every page must not have changed a single figure.
    for (const p of bookProblems()) assert(false, `after opening every page: ${p}`);

    const slow = info
      .filter((l) => / \d+ms$/.test(l))
      .map((l) => [l, Number(/ (\d+)ms$/.exec(l)![1])] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([l]) => l);
    R.fails.push(`(${info[0]})`, `(slowest pages: ${slow.join(", ")})`);
    return R;
  } catch (e) {
    R.failed++;
    R.fails.push(`aborted on ${currentPage}: ${(e as Error)?.stack ?? String(e)}`);
    return R;
  }
}
