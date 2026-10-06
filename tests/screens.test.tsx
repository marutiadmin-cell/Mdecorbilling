/**
 * Screen render tests — run in a real browser (see tests/run-screens.cjs).
 *
 * audit.test.ts proves the MATH. This proves the SCREENS: that every page
 * actually renders seeded data, and that the numbers which reach the DOM are
 * the ones the ledger says they should be.
 *
 * It exists because the v50 refactor moved every repo-derived `useMemo` in
 * these pages onto `useRepoMemo`, and nothing but tsc was exercising them —
 * a blank page, or a stale zero, would have shipped unseen.
 *
 * Why a browser and not renderToString: most list screens load their rows in
 * a `useEffect`, which server rendering never runs, so they would all render
 * empty and the test would prove nothing. Mounting for real with createRoot
 * runs effects, which is exactly the code path being verified.
 *
 * Safety: `@/lib/firebase` is aliased to tests/stubs/firebase (isBrowser =
 * false), so the repositories are pure in-memory caches here and there is no
 * code path to the live database.
 */
import { createRoot, type Root } from "react-dom/client";
import { act, type ReactNode } from "react";
import { createRouter, createMemoryHistory, RouterProvider, Outlet } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "@/routeTree.gen";
import { BulkUpdateItemsDialog } from "@/components/BulkUpdateItemsDialog";
import { PrintablePartyStatement } from "@/components/PrintablePartyStatement";
import { CashBankTransferDialog } from "@/components/CashBankTransferDialog";
import { PartyDialog } from "@/routes/parties";
import { DataTable } from "@/components/DataTable";
import { PrintableInvoice } from "@/components/PrintableInvoice";
import { ThermalReceipt } from "@/components/ThermalReceipt";
import { PrintableReturn } from "@/components/PrintableReturn";
import { fmtMoney, ymd } from "@/lib/format";
import { planStockRepair } from "@/lib/dataRepair";
import { useEscapeToLeave } from "@/hooks/useFormKeys";
import { useAppEscape } from "@/hooks/useGoBack";
import { useWorkspace } from "@/store/workspace";
import { buildPartyStatement, cashFlows, netFlow } from "@/lib/ledger";
import { commitBatch } from "@/repositories/base";
import {
  PartyRepo,
  ItemRepo,
  SalesRepo,
  PurchaseRepo,
  SaleReturnRepo,
  ExpenseRepo,
  PayeeRepo,
  BankRepo,
  BankTxnRepo,
  PaymentRepo,
  CompanyRepo,
  StockAdjustmentRepo,
  BusinessDocRepo,
  EstimateRepo,
  nextInvoiceNumber,
  PurchaseReturnRepo,
  CashAdjustmentRepo,
} from "@/repositories";

export interface Results {
  passed: number;
  failed: number;
  fails: string[];
}

const R: Results = { passed: 0, failed: 0, fails: [] };
const r2 = (n: number) => Math.round(n * 100) / 100;
function assert(cond: boolean, msg: string) {
  if (cond) R.passed++;
  else {
    R.failed++;
    R.fails.push(msg);
  }
}
/** Assert a rendered page contains a value, naming what was missing. */
function has(text: string, needle: string, label: string) {
  assert(text.includes(needle), `${label} — expected to find ${JSON.stringify(needle)}`);
}

/** Type into a controlled React input the way a person does — React listens
 * for the native `input` event, and setting `.value` alone never fires it. */
function setInput(el: HTMLInputElement | null | undefined, value: string) {
  // A missing control used to surface as "Illegal invocation" from deep in
  // the value setter, which says nothing about which control was missing.
  if (!el) throw new Error(`setInput: the control to type "${value}" into is not on screen`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The bulk-update grid row whose first cell holds this item name, as its
 * list of inputs: [name, ...the current tab's fields]. Returns null when the
 * row is not mounted — which the windowed list makes a normal state. */
function gridRow(name: string): HTMLInputElement[] | null {
  for (const table of Array.from(document.querySelectorAll("table"))) {
    for (const tr of Array.from(table.querySelectorAll("tbody tr"))) {
      const inputs = Array.from(tr.querySelectorAll("input")) as HTMLInputElement[];
      if (inputs.length && inputs[0].value === name) return inputs;
    }
  }
  return null;
}

/** The dialog under test: the LAST one in the document.
 *
 * Routes and dialogs mounted by earlier blocks are never torn down, and they
 * portal into document.body, so a bare document.querySelector('[role="dialog"]')
 * happily returns something another test opened. Portals append, so the newest
 * is last. */
function currentDialog(): Element {
  const all = document.querySelectorAll('[role="dialog"]');
  const el = all[all.length - 1];
  if (!el) throw new Error("currentDialog: no dialog is open");
  return el;
}

function findButton(re: RegExp): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((b) =>
    re.test((b.textContent ?? "").trim()),
  ) as HTMLButtonElement | undefined;
}

/** Let React's effects, timers and rAF-coalesced scroll handlers settle. */
async function settleMs(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

// Dates inside the CURRENT month, so the screens' default "this month"
// filters include them however long from now this test is run.
const now = new Date();
const inMonth = (day: number) =>
  ymd(new Date(now.getFullYear(), now.getMonth(), Math.min(day, now.getDate())));
const D2 = inMonth(2),
  D3 = inMonth(3),
  D4 = inMonth(4),
  D5 = inMonth(5);

/* ── A small but complete book ────────────────────────────────────────── */
function seed() {
  CompanyRepo.save({
    name: "M DECOR",
    // Registered in Gujarat (24). The seller's state comes from its own
    // GSTIN, so this one number decides intra against inter for every bill.
    gstin: "24AAACC1234D1ZI",
    currency: "INR",
    invoicePrefix: "INV-",
    purchasePrefix: "PUR-",
    enableGst: true,
    allowNegativeStock: true,
    expenseCategories: ["Rent"],
  } as never);

  /* Two customers that differ only in where they are — the whole point of
     the GST rules. Both GSTINs are real-shaped and pass the checksum. */
  PartyRepo.add({
    id: "PARTY-GJ",
    createdAt: "2026-01-01T00:00:00Z",
    name: "Surat Steels",
    type: "customer",
    gstin: "24AAACC1234D1ZI",
    state: "Gujarat",
    stateCode: "24",
    city: "Surat",
    openingBalance: 0,
  } as never);
  PartyRepo.add({
    id: "PARTY-MH",
    createdAt: "2026-01-01T00:00:00Z",
    name: "Mumbai Fabricators",
    type: "customer",
    gstin: "27AAACC1234D1ZC",
    state: "Maharashtra",
    stateCode: "27",
    city: "Mumbai",
    openingBalance: 0,
  } as never);

  /* A quotation waiting to be converted — the first step of the sequence. */
  EstimateRepo.add({
    id: "EST-Q1",
    createdAt: "2026-09-01T00:00:00Z",
    kind: "quotation",
    status: "open",
    number: "QT-0001",
    date: "2026-09-01",
    validUntil: "2026-12-31",
    partyId: "PARTY-MH",
    partyName: "Mumbai Fabricators",
    partyGstin: "27AAACC1234D1ZC",
    partyState: "Maharashtra",
    placeOfSupply: "27",
    gstEnabled: true,
    lineItems: [
      {
        id: "L",
        itemId: "I1",
        name: "USB Cable",
        qty: 5,
        unit: "pcs",
        price: 100,
        discountPct: 0,
        gstRate: 18,
        amount: 590,
      },
    ],
    subtotal: 500,
    discount: 0,
    taxAmount: 90,
    total: 590,
  } as never);

  PartyRepo.add({
    id: "P1",
    createdAt: "2026-01-01T00:00:00Z",
    name: "Ramesh Traders",
    type: "both",
    phone: "9876500001",
    openingBalance: 0,
  } as never);
  PartyRepo.add({
    id: "P2",
    createdAt: "2026-01-02T00:00:00Z",
    name: "Sunrise Supply",
    type: "both",
    phone: "9876500002",
    openingBalance: 0,
  } as never);

  // The business's own paperwork — the vault the business asked for.
  BusinessDocRepo.add({
    id: "DOC1",
    createdAt: "2026-09-01T00:00:00Z",
    name: "GST Certificate",
    fileName: "gst-2026.pdf",
    contentType: "application/pdf",
    size: 245760,
    storagePath: "business-docs/DOC1/gst-2026.pdf",
    note: "Renewed Sept 2026",
  } as never);

  ItemRepo.add({
    id: "I1",
    createdAt: "2026-01-01T00:00:00Z",
    name: "USB Cable",
    unit: "pcs",
    gstRate: 18,
    purchasePrice: 60,
    salePrice: 100,
    stock: 40,
    openingStock: 50,
    minStock: 5,
  } as never);
  ItemRepo.add({
    id: "I2",
    createdAt: "2026-01-01T00:00:00Z",
    name: "Phone Case",
    unit: "pcs",
    gstRate: 18,
    purchasePrice: 90,
    salePrice: 150,
    stock: 2,
    openingStock: 10,
    minStock: 5,
  } as never);

  BankRepo.add({
    id: "B1",
    createdAt: "2026-01-01T00:00:00Z",
    name: "HDFC Current",
    accountNumber: "1234",
    openingBalance: 10000,
    balance: 11400,
  } as never);

  // A 1000 sale with 400 of it settled at billing through bank B1.
  SalesRepo.add({
    id: "S1",
    createdAt: `${D2}T09:00:00Z`,
    number: "INV-0001",
    date: D2,
    partyId: "P1",
    partyName: "Ramesh Traders",
    partyPhone: "9876500001",
    gstEnabled: false,
    lineItems: [
      {
        id: "L1",
        itemId: "I1",
        name: "USB Cable",
        unit: "pcs",
        qty: 10,
        price: 100,
        discountPct: 0,
        gstRate: 0,
        costPrice: 60,
        amount: 1000,
      },
    ],
    subtotal: 1000,
    discount: 0,
    shippingCharge: 0,
    taxAmount: 0,
    total: 1000,
    paid: 400,
    paymentMode: "bank",
    bankId: "B1",
    bankPaidAmount: 400,
    notes: "",
  } as never);

  PurchaseRepo.add({
    id: "PU1",
    createdAt: `${D3}T09:00:00Z`,
    number: "PUR-0001",
    date: D3,
    partyId: "P2",
    partyName: "Sunrise Supply",
    gstEnabled: false,
    lineItems: [
      {
        id: "L2",
        itemId: "I2",
        name: "Phone Case",
        unit: "pcs",
        qty: 5,
        price: 90,
        discountPct: 0,
        gstRate: 0,
        amount: 450,
      },
    ],
    subtotal: 450,
    discount: 0,
    taxAmount: 0,
    total: 450,
    paid: 0,
    paymentMode: "credit",
    notes: "",
  } as never);

  SaleReturnRepo.add({
    id: "SR1",
    createdAt: `${D4}T09:00:00Z`,
    number: "CR-0001",
    date: D4,
    originalRef: "INV-0001",
    partyId: "P1",
    partyName: "Ramesh Traders",
    gstEnabled: false,
    lineItems: [
      {
        id: "L3",
        itemId: "I1",
        name: "USB Cable",
        unit: "pcs",
        qty: 1,
        price: 100,
        discountPct: 0,
        gstRate: 0,
        costPrice: 60,
        amount: 100,
      },
    ],
    subtotal: 100,
    taxAmount: 0,
    total: 100,
    notes: "",
  } as never);

  PaymentRepo.add({
    id: "PY1",
    createdAt: `${D5}T09:00:00Z`,
    date: D5,
    partyId: "P1",
    partyName: "Ramesh Traders",
    type: "in",
    amount: 300,
    mode: "cash",
  } as never);
  PayeeRepo.add({ id: "PE1", createdAt: "2026-01-01T00:00:00Z", name: "Landlord" } as never);
  ExpenseRepo.add({
    id: "E1",
    createdAt: `${D3}T09:00:00Z`,
    date: D3,
    category: "Rent",
    amount: 5000,
    paymentMode: "cash",
    payeeId: "PE1",
    payeeName: "Landlord",
  } as never);
  BankTxnRepo.add({
    id: "BT1",
    createdAt: `${D4}T09:00:00Z`,
    bankId: "B1",
    date: D4,
    type: "deposit",
    amount: 1000,
    notes: "Counter cash",
  } as never);
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

/** Mount one URL for real (effects included) and return its visible text. */
async function renderRoute(path: string | string[]): Promise<string> {
  // An ARRAY is the route you arrived through — the last entry is the page
  // being tested and the ones before it are real history, which is the only
  // way to exercise a back button for what it is.
  const entries = Array.isArray(path) ? path : [path];
  const router = createRouter({
    routeTree,
    context: { queryClient: new QueryClient() },
    history: createMemoryHistory({ initialEntries: entries }),
  });
  await router.load();

  if (root) root.unmount();
  if (host) host.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);

  await act(async () => {
    root!.render(<RouterProvider router={router} />);
  });
  // Let post-render effects (the list screens' data load) settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  return host.textContent ?? "";
}

/**
 * The bill form mounts a desk table and a phone card list at once and lets
 * CSS hide one of them, so "the add-item field" is a question with two
 * answers. The hidden one cannot be focused or typed into — focus() on a
 * display:none input is a no-op — so every test that drives this field has
 * to ask for the one actually on screen.
 */
function visibleAddItemInput(): HTMLInputElement | null {
  const all = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[placeholder="Type item name to add…"]'),
  );
  return all.find((el) => el.offsetParent !== null) ?? all[0] ?? null;
}

/** Re-read the currently mounted page after letting React settle. */
async function readMounted(): Promise<string> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  return host?.textContent ?? "";
}

/**
 * Keep whatever passed when a step throws.
 *
 * A missing control aborts the rest of the run, and the harness used to
 * replace the entire result with the exception — so a single broken selector
 * reported "0 passed" and hid both the assertions that had already run AND
 * the ones that explain why. The count is now honest and the error is just
 * one more failure line.
 */
export async function run(): Promise<Results> {
  try {
    return await runAll();
  } catch (e) {
    R.failed++;
    R.fails.push(`aborted: ${(e as Error)?.stack ?? String(e)}`);
    return R;
  }
}

async function runAll(): Promise<Results> {
  const rootOptions = (routeTree as unknown as { options: Record<string, unknown> }).options;
  // Swap the root component for a bare Outlet: the real one is the auth gate,
  // which needs a live Firebase session this test deliberately cannot have.
  // The real root is the auth gate, which needs a live Firebase session this
  // test deliberately cannot have — but it also mounts the app-wide key
  // handling, so the stand-in has to keep THAT or every keyboard test here
  // would be exercising a page the shop never runs.
  rootOptions.component = function TestRoot() {
    useAppEscape();
    return <Outlet />;
  };
  // And drop the document shell — it renders <html><body>, which cannot be
  // mounted inside a container div.
  rootOptions.shellComponent = ({ children }: { children: ReactNode }) => <>{children}</>;
  // React refuses to run act() unless the environment opts in.
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__TEST_IS_OWNER__ = true;

  /* ── THE cold-open regression ─────────────────────────────────────────
     This is the bug the v50 refactor was about, and the only test here that
     reproduces it: the app now renders BEFORE the collections have loaded,
     so a screen must fill in when data arrives later — not stay frozen on
     whatever the cache held at mount. Deleting the repo-version dependency
     (which the lint rule actively suggests) makes exactly this fail, while
     every seeded-first assertion below would still pass.                  */
  // (a) a list screen, which fills in through `useEffect(refresh, [_repoV])`
  const emptyList = await renderRoute("/sales");
  assert(
    !emptyList.includes("INV-0001"),
    "cold open: the sales list must start empty before any data has arrived",
  );

  // (b) a derived screen, which fills in through `useRepoMemo` — this is the
  //     mechanism the refactor replaced, so it is the one that has to be
  //     pinned. Mount it empty FIRST, then let data arrive underneath it.
  const emptyPl = await renderRoute("/reports?r=pl");
  assert(
    !emptyPl.includes(fmtMoney(1000)),
    "cold open: P&L must start at zero before any data has arrived",
  );

  // Data lands afterwards, exactly as a Firestore snapshot would deliver it.
  await act(async () => {
    seed();
  });

  const plAfterArrival = await readMounted();
  has(plAfterArrival, fmtMoney(1000), "cold open: P&L fills in once data arrives (no remount)");
  has(plAfterArrival, fmtMoney(360), "cold open: derived gross profit fills in too");

  /* ── Every screen, measured as a phone ────────────────────────────────
     Reported after a client call: Party, Sales, Purchase and the two invoice
     forms were "nothing proper" next to Vyapar. Measured at 390px before
     touching anything, because the complaint named no specific thing.

     Nothing was spilling and no table was being dragged sideways — the layout
     has been responsive for a while. It was desktop density shrunk onto a
     phone: fourteen controls under 40px on Parties alone, four of them 26px
     SQUARE. The gap between 26px and 44px is the difference between pressing
     edit and pressing delete.

     Every screen is checked, not only the five that were complained about —
     the fix is a floor in styles.css and a floor is only worth having if
     something notices when a screen slips under it.

     Thresholds, and why each:
       44px  — what Apple and Google both publish as a thumb target.
       16px  — below it iOS zooms the page on focus and never zooms back.
       12px  — secondary text staff read to pick the right row.

     Two deliberate exemptions:
       · A printable document. An invoice preview is laid out for A4 and its
         9-11px type is what the paper gets; forcing it to 12px would change
         the printed page to fix a screen. It is pinch-zoomed or downloaded.
       · Anything inside a horizontal scroller, and the offscreen PDF source,
         which is parked past the edge on purpose and nobody looks at.

     Runs only at a phone viewport: `npm run test:screens` alone does NOT
     cover this, because at the default 800px there is nothing to find.
     SCREENS_VIEWPORT=390x844 does. */
  if (window.innerWidth <= 480) {
    const PHONE_ROUTES = [
      "/parties",
      "/sales",
      "/purchase",
      "/sales/new",
      "/purchase/new",
      "/parties/P1",
      "/sales/S1",
      "/documents",
      "/quotations",
      "/proforma",
      "/items",
      "/payments",
      "/expenses",
      "/cash",
      "/bank",
      "/inventory",
      "/daybook",
      "/gst",
      "/reports",
      "/settings",
      "/sale-return",
      "/purchase-return",
    ];

    for (const route of PHONE_ROUTES) {
      await renderRoute(route);
      await settleMs(160);
      const scope = host as HTMLElement;
      const W = window.innerWidth;

      const spills: string[] = [];
      const smallText: string[] = [];
      const smallTaps: string[] = [];

      scope.querySelectorAll<HTMLElement>("*").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || el.offsetParent === null) return;
        const cs = getComputedStyle(el);

        /* A scrolling region may be wider than the screen — that is what makes
           it scroll — and so may anything inside one. Only something wide with
           no scroller above it is actually off the edge of the phone. */
        let scrollable = false;
        for (let p: HTMLElement | null = el; p && p !== scope; p = p.parentElement) {
          if (/auto|scroll/.test(getComputedStyle(p).overflowX)) {
            scrollable = true;
            break;
          }
        }
        const offscreenSource = !!el.closest("[data-pdf-source]");
        if (!scrollable && !offscreenSource && (r.right > W + 1 || r.left < -1)) {
          spills.push(el.tagName + "." + String(el.className).slice(0, 34));
        }

        const inDocument = !!el.closest("[data-pdf-source],.print-area,.print-visible");
        const txt = (el.textContent ?? "").trim();
        if (txt && !inDocument && el.children.length === 0 && parseFloat(cs.fontSize) < 12) {
          smallText.push(`${cs.fontSize} "${txt.slice(0, 16)}"`);
        }

        const tappable =
          el.tagName === "BUTTON" ||
          el.tagName === "SELECT" ||
          el.getAttribute("role") === "button";
        if (tappable && !inDocument && (r.height < 44 || r.width < 44)) {
          smallTaps.push(
            `${el.tagName}[${txt.slice(0, 12)}] ${Math.round(r.width)}x${Math.round(r.height)}`,
          );
        }
      });

      const inputs = Array.from(scope.querySelectorAll<HTMLInputElement>("input")).filter(
        (el) =>
          el.offsetParent !== null &&
          el.type !== "checkbox" &&
          el.type !== "radio" &&
          !el.closest("[data-pdf-source],.print-area,.print-visible"),
      );
      const tiny = inputs.filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16);
      const short = inputs.filter((el) => el.getBoundingClientRect().height < 44);

      assert(
        spills.length === 0,
        `phone ${route}: nothing runs off the side — ${spills.slice(0, 3).join(" | ")}`,
      );
      assert(
        smallTaps.length === 0,
        `phone ${route}: every control is thumb-sized — ${smallTaps.slice(0, 4).join(" | ")}`,
      );
      assert(
        smallText.length === 0,
        `phone ${route}: nothing on screen is under 12px — ${smallText.slice(0, 4).join(" | ")}`,
      );
      assert(
        tiny.length === 0,
        `phone ${route}: no box small enough to make iOS zoom the page — ${tiny.length}`,
      );
      assert(short.length === 0, `phone ${route}: no box shorter than a thumb — ${short.length}`);
    }
  }

  /* ── Nothing on a bill spills off the side of a phone ─────────────────
     Reported as "sale and purchase invoice form not responsive, many bugs".
     Measured rather than guessed: at a phone width, walk the form and report
     anything wider than the screen it has to fit on. Runs only when the
     suite is given a phone viewport, because at the default 800px there is
     nothing to find. */
  if (window.innerWidth <= 480) {
    await renderRoute("/sales/new");
    await settleMs(120);

    const scope = host as HTMLElement;
    assert(
      scope.querySelectorAll("*").length > 50,
      "mobile bill: the form is actually mounted — " +
        scope.querySelectorAll("*").length +
        " nodes",
    );

    const overflow: string[] = [];
    scope.querySelectorAll<HTMLElement>("*").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      // Its own scrolling region is allowed to be wider than the screen —
      // that is what makes it scroll. Anything else is a spill.
      const scrolls = /auto|scroll/.test(getComputedStyle(el).overflowX);
      if (scrolls) return;
      if (r.right > window.innerWidth + 1 || r.left < -1) {
        const cls = (el.className || "").toString().slice(0, 60);
        overflow.push(
          el.tagName + "." + cls + " @" + Math.round(r.left) + ".." + Math.round(r.right),
        );
      }
    });
    assert(
      overflow.length === 0,
      "mobile bill: nothing spills off the screen — " + overflow.slice(0, 6).join(" | "),
    );

    /* ── The lines are a card list, not a table dragged sideways ────────
       The nine-column row needs 720px; the phone has 390. The photograph
       from the counter shows the result: Qty, Price and Amount on screen
       and the item NAME scrolled off to the left, so the person billing
       cannot see what they are billing for. */
    const wideTable = Array.from(document.querySelectorAll<HTMLElement>("table")).find((t) =>
      t.className.includes("min-w-[720px]"),
    );
    assert(!!wideTable, "mobile bill: the desktop item table is still built");
    assert(
      !wideTable || wideTable.offsetParent === null,
      "mobile bill: but a phone is not shown it",
    );

    /* ── A dropdown that opens on the screen ────────────────────────────
       Photographed: the item search opened with its prices hanging off the
       right edge, because it was anchored to an input inside that 720px
       table and nothing compared the answer to the width of the phone. */
    const phoneAdd = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[placeholder="Type item name to add…"]'),
    ).find((el) => el.offsetParent !== null);
    assert(!!phoneAdd, "mobile bill: the phone layout offers an add-item field");

    if (phoneAdd) {
      await act(async () => {
        phoneAdd.focus();
        setInput(phoneAdd, "USB Cable");
      });
      await settleMs(160);

      const panel = Array.from(document.body.querySelectorAll<HTMLElement>("div")).find(
        (d) =>
          getComputedStyle(d).position === "fixed" &&
          d.className.includes("z-50") &&
          (d.textContent ?? "").includes("USB Cable"),
      );
      assert(!!panel, "mobile bill: typing an item name opens the picker");
      if (panel) {
        const pr = panel.getBoundingClientRect();
        assert(
          pr.left >= -1 && pr.right <= window.innerWidth + 1,
          "mobile bill: the picker opens fully on the screen — " +
            Math.round(pr.left) +
            ".." +
            Math.round(pr.right) +
            " of " +
            window.innerWidth,
        );
        assert(
          pr.top >= -1 && pr.bottom <= window.innerHeight + 1,
          "mobile bill: and fully above the bottom of it — " +
            Math.round(pr.top) +
            ".." +
            Math.round(pr.bottom),
        );

        /* ── And the name of what was added stays readable ──────────── */
        /* The OPTION, not whatever container happens to start with the same
           text: when the item is first in the list, the scroller's own
           textContent starts with it too, and a mousedown on the scroller
           never reaches the row's handler. data-opt marks the real one. */
        const option = Array.from(panel.querySelectorAll<HTMLElement>("[data-opt]")).find((d) =>
          (d.textContent ?? "").startsWith("USB Cable"),
        );
        assert(!!option, "mobile bill: the item is offered");
        if (option) {
          await act(async () => {
            option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          });
          await settleMs(200);

          const nameEl = Array.from(scope.querySelectorAll<HTMLElement>("div")).find(
            (d) =>
              (d.textContent ?? "").trim() === "USB Cable" &&
              d.children.length === 0 &&
              d.offsetParent !== null &&
              d.getBoundingClientRect().width > 0,
          );
          assert(!!nameEl, "mobile bill: the added item's name is on the page");
          if (nameEl) {
            const nr = nameEl.getBoundingClientRect();
            assert(
              nr.left >= -1 && nr.right <= window.innerWidth + 1,
              "mobile bill: and wholly on the screen without dragging it sideways — " +
                Math.round(nr.left) +
                ".." +
                Math.round(nr.right),
            );
          }

          /* ── The last-prices popup, which walked off the LEFT ───────
             It right-aligns itself by subtracting its own 256px width from
             the input's right edge. On a phone card the Price box ends
             around x=190, so that arithmetic produces a negative x — which
             is the second photograph from the counter: the heading "LAST
             SALE PRICES — GOPAL MOBILE" cut off by the edge of the screen.
             It only appears once the bill has a party, because it is that
             party's own history.

             Honest about what this proves: in the CARD layout the Price box
             sits far enough right that the subtraction lands on screen even
             unclamped — removing the clamp does not make this fail. It is a
             regression guard on the shipped layout. The clamp itself is
             proved by TEST PP in the audit suite, where the anchor can be
             put where the photograph found it. */
          const partyInput = Array.from(
            scope.querySelectorAll<HTMLInputElement>('input[placeholder="Type name or search…"]'),
          ).find((el) => el.offsetParent !== null);
          if (partyInput) {
            await act(async () => {
              partyInput.focus();
              setInput(partyInput, "Ramesh");
            });
            await settleMs(140);
            const partyOpt = Array.from(document.querySelectorAll<HTMLElement>("div")).find(
              (d) =>
                (d.textContent ?? "").trim() === "Ramesh Traders" &&
                !d.querySelector("div div") &&
                !d.querySelector("input"),
            );
            if (partyOpt) {
              await act(async () => {
                partyOpt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
              });
              await settleMs(160);
            }

            const priceBox = Array.from(scope.querySelectorAll<HTMLInputElement>("input")).find(
              (el) =>
                el.offsetParent !== null &&
                el.className.includes("h-11") &&
                (el.parentElement?.textContent ?? "").trim().toUpperCase() === "PRICE",
            );
            assert(!!priceBox, "mobile bill: the card has a Price box");
            if (priceBox) {
              await act(async () => {
                priceBox.focus();
                priceBox.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
              });
              await settleMs(160);
              const pricePanel = Array.from(
                document.body.querySelectorAll<HTMLElement>("div"),
              ).find(
                (d) =>
                  getComputedStyle(d).position === "fixed" &&
                  d.className.includes("z-50") &&
                  (d.textContent ?? "").includes("Prices"),
              );
              assert(!!pricePanel, "mobile bill: the last-prices popup opens");
              if (pricePanel) {
                const lr = pricePanel.getBoundingClientRect();
                assert(
                  lr.left >= -1,
                  "mobile bill: the last-prices popup does not run off the left — left " +
                    Math.round(lr.left),
                );
                assert(
                  lr.right <= window.innerWidth + 1,
                  "mobile bill: nor off the right — right " + Math.round(lr.right),
                );
              }
            }
          }

          /* Every box on a phone card is at least 16px of text: below that,
             iOS zooms the page the moment it is focused and the bill jumps
             out from under the person filling it in. */
          const small = Array.from(scope.querySelectorAll<HTMLInputElement>("input"))
            .filter((el) => el.offsetParent !== null && el.type !== "checkbox")
            .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
            .map((el) => (el.id || el.placeholder || el.className.slice(0, 30)) + " ")
            .slice(0, 5);
          assert(
            small.length === 0,
            "mobile bill: no box small enough to make iOS zoom the page — " + small.join("| "),
          );
        }
      }
    }
  }

  const listAfterArrival = await renderRoute("/sales");
  has(listAfterArrival, "INV-0001", "cold open: the list screen shows the arrived data");

  /* ── Expected values, derived by hand from the seed above ───────────── */
  // Sale 1000 − return 100 = 900 net revenue (neither bill carries GST).
  // COGS = 10x60 − 1x60 = 540. Gross profit 360. Expenses 5000 → net −4640.
  const pl = await renderRoute("/reports?r=pl");
  has(pl, "Sales Revenue (excl. GST)", "P&L: GST-exclusive revenue label");
  has(pl, fmtMoney(1000), "P&L: sales revenue 1000");
  has(pl, fmtMoney(540), "P&L: COGS 540");
  has(pl, fmtMoney(360), "P&L: gross profit 360");
  has(pl, fmtMoney(-4640), "P&L: net profit -4640");

  // Statement: 1000 invoiced − 100 returned − 400 settled − 300 advance = 200.
  const statement = await renderRoute("/parties/P1");
  has(statement, "Ramesh Traders", "statement: party name");
  has(statement, "INV-0001", "statement: the invoice row");
  has(statement, "CR-0001", "statement: the credit note row");
  has(statement, fmtMoney(200), "statement: closing balance 200");

  // Passbook: opening 10000 + 400 sale receipt + 1000 deposit = 11400, which
  // must equal the account's stored balance.
  const passbook = await renderRoute("/bank/B1");
  has(passbook, "HDFC Current", "passbook: account name");
  has(passbook, fmtMoney(11400), "passbook: derived balance 11400 matches stored");
  has(passbook, fmtMoney(400), "passbook: the sale receipt");
  has(passbook, fmtMoney(1000), "passbook: the deposit");

  // Item page: 10 sold, 1 returned, profit = 9 x (100 − 60) = 360.
  const item = await renderRoute("/items/I1");
  has(item, "USB Cable", "item page: name");
  has(item, "INV-0001", "item page: sale in history");
  has(item, fmtMoney(360), "item page: profit earned 360");

  const payee = await renderRoute("/payees/PE1");
  has(payee, "Landlord", "payee page: name");
  has(payee, fmtMoney(5000), "payee page: the rent expense");

  /* ── Dashboard: every figure on the home page, derived by hand ───────
     The client reports the home page totals as wrong, so each card is
     pinned to an independently-computed value rather than to whatever the
     code happens to produce. `fmt` mirrors the dashboard's own formatter
     (en-IN, no decimals). */
  const fmt = (n: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n);
  const home = await renderRoute("/");
  // P1: 1000 invoiced − 100 returned − 400 settled − 300 advance = 200
  has(home, `₹ ${fmt(200)}`, "dashboard: Total Receivable = 200");
  // P2: 450 purchased, nothing paid = 450
  has(home, `₹ ${fmt(450)}`, "dashboard: Total Payable = 450");
  // cash-mode only: +300 payment in, −5000 expense (the sale settled by bank)
  has(home, `₹ ${fmt(-4700)}`, "dashboard: Cash On Hand = −4700");
  // stored 11400; the sale is tied to account B1 so it is NOT added again
  has(home, `₹ ${fmt(11400)}`, "dashboard: Total Bank Balance = 11400");
  // 40×60 + 2×90
  has(home, `₹ ${fmt(2580)}`, "dashboard: Stock Value = 2580");
  has(home, `₹ ${fmt(450)}`, "dashboard: Purchases this period = 450");
  has(home, `₹ ${fmt(5000)}`, "dashboard: Expenses this period = 5000");
  // 1000 − 100 − 540 COGS − 5000 expenses (GST-exclusive, so unchanged here)
  has(home, `₹ ${fmt(-4640)}`, "dashboard: Net Profit = −4640");

  // Back belongs on DETAIL pages — the ones you drill into and have to get
  // out of. Main pages are reached from the sidebar/tab bar, so there is
  // nothing to go back to and a lone chevron beside the title just looks
  // broken. Both halves are asserted so neither drifts.
  const backCount = () => document.querySelectorAll('[aria-label="Go back"]').length;
  for (const url of ["/parties/P1", "/items/I1", "/bank/B1", "/payees/PE1"]) {
    await renderRoute(url);
    assert(backCount() > 0, url + ": detail page must offer a back control");
  }
  for (const url of ["/parties", "/items", "/expenses", "/reports", "/daybook", "/settings"]) {
    await renderRoute(url);
    assert(backCount() === 0, url + ": main page must NOT show a back arrow");
  }

  // Expenses: edit and delete must be visible controls, not just a row
  // click and a Ctrl+Delete nobody can discover.
  const expensesPage = await renderRoute("/expenses");
  has(expensesPage, "Action", "expenses: row actions column is present");

  // Items page: the old "apply one operation to everything" bulk edit was
  // replaced by the Bulk Update Items screen, reachable without selecting.
  const itemsPage = await renderRoute("/items");
  has(itemsPage, "Bulk Update", "items: the new bulk update entry point");
  assert(!itemsPage.includes("Bulk Edit"), "items: the replaced Bulk Edit button must be gone");

  const daybook = await renderRoute(`/daybook?date=${D3}`);
  has(daybook, "PUR-0001", "daybook: the purchase");
  has(daybook, fmtMoney(5000), "daybook: the expense");

  // Owner-only sections of Settings must be invisible to a non-owner and
  // present for an owner — both sides of the gate, on the same page.
  globalThis.__TEST_IS_OWNER__ = false;
  const staffSettings = await renderRoute("/settings");
  has(staffSettings, "Company Details", "settings (staff): ordinary section");
  assert(
    !staffSettings.includes("Fix Calculations"),
    "settings (staff): the owner-only recalculation tool must be hidden",
  );
  assert(!staffSettings.includes("Team"), "settings (staff): owner-only Team must be hidden");

  globalThis.__TEST_IS_OWNER__ = true;
  const ownerSettings = await renderRoute("/settings");
  has(ownerSettings, "Fix Calculations", "settings (owner): the recalculation tool");
  has(ownerSettings, "Check Calculations", "settings (owner): the recalculation action");
  has(ownerSettings, "Check Calculations", "settings (owner): the recalculation action");
  has(ownerSettings, "Team", "settings (owner): team section");

  /* ── Every remaining screen must render real content, not blow up ───── */
  const pages: [string, string][] = [
    ["/", "Total Receivable"],
    ["/parties", "Ramesh Traders"],
    ["/items", "USB Cable"],
    ["/inventory", "USB Cable"],
    ["/sales", "INV-0001"],
    ["/purchase", "PUR-0001"],
    ["/sale-return", "CR-0001"],
    ["/purchase-return", "Purchase Return"],
    ["/expenses", "Rent"],
    ["/payees", "Landlord"],
    ["/bank", "HDFC Current"],
    ["/cash", "Cash"],
    ["/payments", "Ramesh Traders"],
    ["/gst", "GST"],
    ["/reports?r=gst", "GST"],
    ["/reports?r=party-ledger", "Ramesh Traders"],
    ["/reports?r=stock", "USB Cable"],
    ["/settings", "Company Details"],
    ["/sales/S1", "INV-0001"],
    ["/purchase/PU1", "PUR-0001"],
    ["/sale-return/SR1", "CR-0001"],
  ];
  for (const [url, needle] of pages) {
    let text = "";
    try {
      text = await renderRoute(url);
    } catch (err) {
      assert(false, `${url} threw while rendering: ${(err as Error).message}`);
      continue;
    }
    assert(text.length > 100, `${url} rendered a suspiciously short page`);
    assert(!/NaN/.test(text), `${url} rendered NaN`);
    /* A comment written as /* … *\/ instead of {/* … *\/} inside JSX is not a
       comment — it is TEXT, and React prints it on the page. It compiles,
       lints and typechecks cleanly, so nothing else in this repo would catch
       it; I shipped one onto the invoice screen and only saw it by reading
       the file back. Cheap to check on every page, once. */
    assert(
      !text.includes("/*"),
      `${url} is printing a JSX comment as visible text — ${JSON.stringify(
        text.slice(Math.max(0, text.indexOf("/*") - 40), text.indexOf("/*") + 80),
      )}`,
    );
    has(text, needle, `${url} content`);
  }

  /* ── A party must never appear in BOTH Receivable and Payable ─────────
     The production case: a payable opening plus a later sale. The party's
     statement netted it correctly while the dashboard counted the party on
     both tiles. */
  {
    PartyRepo.update("P2", { openingBalance: -9850 });
    SalesRepo.add({
      id: "NETS1",
      createdAt: `${D5}T10:00:00Z`,
      number: "INV-9002",
      date: D5,
      partyId: "P2",
      partyName: "Sunrise Supply",
      gstEnabled: false,
      lineItems: [],
      subtotal: 11000,
      discount: 0,
      taxAmount: 0,
      total: 11000,
      paid: 0,
      paymentMode: "credit",
      notes: "",
    } as never);

    // opening −9850 + 11000 sale − 450 purchase = 700 receivable, and the
    // party must be gone from Payable entirely.
    const netHome = await renderRoute("/");
    has(netHome, "₹ 900", "netting: receivable is P1's 200 + P2's netted 700");
    has(netHome, "From 2 Parties", "netting: both parties counted once");
    assert(
      !netHome.includes("₹ 9,850") && !netHome.includes("₹ 10,300"),
      "netting: the payable opening must NOT also stand on its own",
    );

    const netParties = await renderRoute("/parties");
    has(netParties, fmtMoney(700), "netting: Parties row shows the netted figure");

    SalesRepo.remove("NETS1");
    PartyRepo.update("P2", { openingBalance: 0 });
  }

  /* ── Changing a party's OPENING BALANCE must reach every screen ───────
     Reported: "they change client opening — receivable, payable, ledger,
     statement, nothing updates". Opening balance is a stored field that
     every derived view folds in, so a change has to surface everywhere. */
  {
    // P2 is the supplier side of the seed and starts at 0.
    PartyRepo.update("P2", { openingBalance: 7000 });

    // Sign convention (as labelled in the party form): POSITIVE means they
    // owe you. P2 also has a 450 purchase bill, and the two NET against each
    // other now — 7000 − 450 = 6550 receivable, plus P1's 200 = 6750. The
    // party no longer stands in Payable at the same time.
    const home = await renderRoute("/");
    has(
      home,
      "₹ 6,750",
      "opening balance: dashboard receivable nets the purchase (7000 − 450 + 200)",
    );

    const list = await renderRoute("/parties");
    has(list, fmtMoney(6550), "opening balance: Parties list row shows the netted figure");

    const stmt = await renderRoute("/parties/P2");
    has(stmt, fmtMoney(7000), "opening balance: statement shows the opening row");

    // A NEGATIVE opening is the "we owe them" side — it must land in payable.
    PartyRepo.update("P2", { openingBalance: -1000 });
    const home2 = await renderRoute("/");
    has(home2, "₹ 1,450", "opening balance: negative opening moves to payable (1000 + 450)");
    assert(
      !home2.includes("₹ 7,200"),
      "opening balance: the old value must be gone after editing it",
    );

    PartyRepo.update("P2", { openingBalance: 0 }); // restore for later assertions
  }

  /* ── Archived party holding money: do the two screens agree? ─────────
     Run LAST, because it mutates the seeded book. Archiving only hides a
     party from pickers — it does not forgive what they owe — so the money
     must not silently disappear from one screen while showing on another. */
  PartyRepo.update("P1", { archived: true });

  const homeAfterArchive = await renderRoute("/");
  has(
    homeAfterArchive,
    `₹ ${fmt(200)}`,
    "archived party: dashboard still counts money they owe (archiving is not forgiveness)",
  );

  const partiesAfterArchive = await renderRoute("/parties");
  assert(
    partiesAfterArchive.includes(fmtMoney(200)),
    "archived party: the Parties page hides ₹200 of receivable that the dashboard counts — " +
      "the two screens disagree",
  );

  /* ── The item dropdown must actually SCROLL ──────────────────────────
     It caps at MAX_SUGGESTIONS rows and is height-limited, so the list has
     to be scrollable — otherwise only the first handful are reachable and
     the rest may as well not exist, which is exactly what the shop saw. */
  {
    // Enough items to overflow the dropdown. Zero stock and zero price so
    // no money assertion above is disturbed.
    for (let i = 0; i < 40; i++) {
      ItemRepo.add({
        id: `DD${i}`,
        createdAt: "2026-01-01T00:00:00Z",
        name: `Dropdown Probe Item ${i}`,
        unit: "pcs",
        gstRate: 0,
        purchasePrice: 0,
        salePrice: 0,
        stock: 0,
        openingStock: 0,
      } as never);
    }

    await renderRoute("/sales/new");
    const namedInputs = Array.from(document.querySelectorAll("input")).filter((el) =>
      (el.getAttribute("placeholder") ?? "").startsWith("Type item name"),
    );
    // The bill renders a desk table and a phone card list at once and hides
    // one of them. Focusing the hidden one does nothing, so take the visible.
    const input = namedInputs.find((el) => el.offsetParent !== null) ?? namedInputs[0];
    assert(!!input, "item dropdown: found the item search input");
    if (input) {
      await act(async () => {
        input.focus();
        input.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 80));
      });

      // The popup is portalled to <body>; find the scrolling list inside it.
      const rows = Array.from(document.querySelectorAll("div")).filter((d) =>
        (d.textContent ?? "").startsWith("Dropdown Probe Item 0"),
      );
      assert(rows.length > 0, "item dropdown: opened and rendered options");

      const scroller = rows[0]?.closest("div.overflow-auto") as HTMLElement | null;
      assert(!!scroller, "item dropdown: options sit inside a scrollable container");
      const popup = scroller?.parentElement as HTMLElement | null;

      // Real layout, measured against the compiled stylesheet.
      if (scroller && popup) {
        assert(
          popup.getBoundingClientRect().height <= 320,
          `item dropdown: popup must stay height-capped — measured ${Math.round(popup.getBoundingClientRect().height)}px`,
        );
        assert(
          scroller.scrollHeight > scroller.clientHeight + 4,
          `item dropdown: list must be scrollable — content ${scroller.scrollHeight}px in ${scroller.clientHeight}px`,
        );

        // Scrolling has to WORK, not merely be possible.
        scroller.scrollTop = 400;
        const immediate = scroller.scrollTop; // before React sees anything
        await act(async () => {
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        const afterScrollEvent = scroller.scrollTop;
        assert(
          immediate > 0,
          `item dropdown: setting scrollTop should stick immediately — got ${immediate}`,
        );
        assert(
          afterScrollEvent > 0,
          `item dropdown: a scroll event must not reset the list — was ${immediate}, became ${afterScrollEvent}`,
        );
        // Let every pending effect and timer settle: the position must
        // SURVIVE them. A re-render used to snap the list back to the top.
        await act(async () => {
          await new Promise((r) => setTimeout(r, 120));
        });
        assert(
          scroller.scrollTop > 0,
          `item dropdown: the scrolled position must survive re-renders — scrollTop fell to ${scroller.scrollTop}`,
        );

        // THE REPORTED BUG: reaching for the scrollbar blurs the input, and
        // the blur handler closes the popup 150ms later — so a long list is
        // unreachable by the one gesture people use to browse it. A mousedown
        // anywhere in the popup (its padding, its scrollbar gutter) must not
        // dismiss it.
        await act(async () => {
          popup.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 300));
        });
        assert(
          document.body.contains(scroller),
          "item dropdown: must stay open when the scrollbar/popup is pressed",
        );
      }
    }
  }

  /* ── Printed documents: every row must match the header ──────────────
     The line table has optional columns (Disc%, GST%, GST Amt). When the
     filler rows or the Item Total row hard-code their cell counts, the
     table grows a phantom empty column hanging off the right edge — which
     is exactly what a real bill looked like. Checked across all four
     combinations so no single flag can break the grid again. */
  {
    const line = (over: Record<string, unknown> = {}) => ({
      id: "PL1",
      itemId: "I1",
      name: "CARRING",
      unit: "pcs",
      qty: 1,
      price: 55000,
      discountPct: 0,
      gstRate: 0,
      amount: 55000,
      ...over,
    });
    const baseInv = (over: Record<string, unknown> = {}) =>
      ({
        id: "PI1",
        number: "0009",
        date: D2,
        partyId: "P1",
        partyName: "LOTUS",
        gstEnabled: false,
        lineItems: [line()],
        subtotal: 55000,
        discount: 0,
        taxAmount: 0,
        total: 55000,
        paid: 0,
        paymentMode: "credit",
        createdAt: `${D2}T09:00:00Z`,
        ...over,
      }) as never;

    const gridHost = document.createElement("div");
    document.body.appendChild(gridHost);
    const gridRoot = createRoot(gridHost);

    /** Widest row wins as the expected width; every row must equal it. */
    const checkGrid = (label: string) => {
      // These documents contain several tables (the Invoice #/Date block is
      // one). Pick the LINE table — the one whose header row has "Qty".
      const table = Array.from(gridHost.querySelectorAll("table")).find((t) =>
        (t.rows[0]?.textContent ?? "").includes("Qty"),
      );
      assert(!!table, `${label}: found the printed line table`);
      if (!table) return;
      const widthOf = (tr: HTMLTableRowElement) =>
        Array.from(tr.cells).reduce((n, c) => n + (c.colSpan || 1), 0);
      const widths = Array.from(table.rows).map(widthOf);
      const expected = Math.max(...widths);
      const bad = widths.filter((w) => w !== expected).length;
      assert(
        bad === 0,
        `${label}: ${bad} row(s) don't span ${expected} columns — got ${widths.join(",")}`,
      );
    };

    const cases: [string, Record<string, unknown>][] = [
      ["invoice no-GST no-discount", {}],
      ["invoice no-GST with line discount", { lineItems: [line({ discountPct: 10 })] }],
      [
        "invoice with GST",
        { gstEnabled: true, taxAmount: 9900, lineItems: [line({ gstRate: 18 })] },
      ],
      [
        "invoice GST + discount",
        { gstEnabled: true, taxAmount: 9900, lineItems: [line({ gstRate: 18, discountPct: 5 })] },
      ],
    ];
    for (const [label, over] of cases) {
      await act(async () => {
        gridRoot.render(
          <PrintableInvoice inv={baseInv(over)} company={CompanyRepo.get()} mode="sale" />,
        );
      });
      checkGrid(label);
    }

    // Return notes share the same layout and had the same fault.
    const baseRet = (over: Record<string, unknown> = {}) =>
      ({
        id: "PR1",
        number: "CR-0009",
        date: D4,
        partyId: "P1",
        partyName: "LOTUS",
        gstEnabled: false,
        lineItems: [line()],
        subtotal: 55000,
        taxAmount: 0,
        total: 55000,
        createdAt: `${D4}T09:00:00Z`,
        ...over,
      }) as never;
    for (const [label, over] of [
      ["return no-GST", {}],
      [
        "return with GST",
        { gstEnabled: true, taxAmount: 9900, lineItems: [line({ gstRate: 18 })] },
      ],
    ] as [string, Record<string, unknown>][]) {
      await act(async () => {
        gridRoot.render(
          <PrintableReturn ret={baseRet(over)} company={CompanyRepo.get()} mode="sale-return" />,
        );
      });
      checkGrid(label);
    }
    gridRoot.unmount();
    gridHost.remove();
  }

  /* ── Quick entry: one amount, settled oldest bill first ───────────────
     The counter takes a round figure off a customer's whole account. This
     drives the real dialog — pick the party, type the amount, type the
     write-off — and checks that the money lands on the right bills in the
     right order and that the bills actually close. spreadFifo's arithmetic is
     pinned in the audit suite; what is pinned HERE is the wiring, which is
     what silently breaks. */
  {
    PartyRepo.add({
      id: "QP",
      createdAt: "2026-01-01T00:00:00Z",
      name: "Quick Entry Customer",
      type: "customer",
      openingBalance: 0,
    } as never);
    // Two open bills, deliberately seeded newest-first so a save that just
    // walks the list in repo order would settle the WRONG one.
    for (const [id, number, date, total] of [
      ["QB2", "INV-QB2", "2026-03-02", 10500],
      ["QB1", "INV-QB1", "2026-03-01", 10000],
    ] as const) {
      SalesRepo.add({
        id,
        createdAt: "2026-01-01T00:00:00Z",
        number,
        date,
        partyId: "QP",
        partyName: "Quick Entry Customer",
        lineItems: [],
        subtotal: total,
        discount: 0,
        shippingCharge: 0,
        taxAmount: 0,
        total,
        paid: 0,
        paymentMode: "credit",
        gstEnabled: false,
      } as never);
    }

    await renderRoute("/payments");
    const receive = findButton(/Receive Payment/);
    assert(
      !!receive,
      `quick entry: found the Receive Payment button — buttons: ${JSON.stringify(
        Array.from(document.querySelectorAll("button"))
          .map((b) => (b.textContent ?? "").trim())
          .filter(Boolean)
          .slice(0, 12),
      )}`,
    );
    if (!receive) throw new Error("quick entry: no Receive button, cannot continue");
    await act(async () => {
      receive.click();
    });
    await settleMs(120);

    const partyBox = document.querySelector(
      'input[placeholder="Type to search party…"]',
    ) as HTMLInputElement | null;
    assert(
      !!partyBox,
      `quick entry: found the party box — inputs on screen: ${JSON.stringify(
        Array.from(document.querySelectorAll("input")).map((i) => i.placeholder || i.type),
      )}`,
    );
    if (!partyBox) throw new Error("quick entry: no party box, cannot continue");
    await act(async () => {
      setInput(partyBox, "Quick Entry");
    });
    await settleMs(80);
    // The DEEPEST div with this text, not the first: when a search narrows to
    // one result, the dropdown container's textContent equals the option's
    // too, and it comes first in document order. Clicking the container does
    // nothing, because React events bubble up, not down.
    const option = Array.from(document.querySelectorAll("div"))
      .filter((d) => d.textContent === "Quick Entry Customer")
      .pop();
    assert(!!option, "quick entry: the party is suggested");
    if (!option) throw new Error("quick entry: party not suggested, cannot continue");
    await act(async () => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await settleMs(120);

    const panel = document.body.textContent ?? "";
    assert(
      panel.includes(fmtMoney(20500)),
      "quick entry: the whole outstanding is shown, not a bill at a time",
    );
    assert(
      panel.includes("Settles oldest invoice first"),
      "quick entry: the allocation preview is on screen",
    );

    // 20,000 taken and 500 written off must close BOTH bills exactly.
    const amountBox = document.querySelector(
      'input[aria-label="Amount received"]',
    ) as HTMLInputElement | null;
    assert(!!amountBox, "quick entry: found the amount box");
    await act(async () => {
      setInput(amountBox, "20000");
    });
    await settleMs(80);
    const discountBox = document.querySelector(
      'input[aria-label="Discount or write-off"]',
    ) as HTMLInputElement | null;
    assert(!!discountBox, "quick entry: found the discount box");
    await act(async () => {
      setInput(discountBox, "500");
    });
    await settleMs(80);

    const preview = document.body.textContent ?? "";
    assert(
      preview.includes("closed") && !preview.includes("untouched"),
      "quick entry: 20,000 + 500 off closes both bills in the preview",
    );

    const confirm = findButton(/Confirm Receipt/);
    assert(!!confirm, "quick entry: found Confirm Receipt");

    /* Nothing is pre-selected any more, so this must refuse until somebody
       says where the money went. The shop asked for the default to go: a
       receipt that records cash because nobody looked at the pills is money
       filed in the wrong place, with nothing to show it was never a
       decision. Asserted BEFORE the happy path, because a guard that quietly
       stopped working would otherwise be invisible here. */
    await act(async () => {
      confirm!.click();
    });
    await settleMs(150);
    assert(
      PaymentRepo.all().filter((p) => p.partyId === "QEP").length === 0,
      "quick entry: confirming without choosing Cash or Bank records nothing",
    );

    const cashPill = document.querySelector('[data-mode="cash"]') as HTMLElement | null;
    assert(!!cashPill, "quick entry: the Cash pill is there to choose");
    await act(async () => {
      cashPill!.click();
    });
    await settleMs(80);

    await act(async () => {
      confirm!.click();
    });
    await settleMs(250);

    assert(
      SalesRepo.get("QB1")?.paid === 10000,
      `quick entry: the OLDEST bill is settled first — QB1 paid ${SalesRepo.get("QB1")?.paid} (want 10000)`,
    );
    assert(
      SalesRepo.get("QB2")?.paid === 10500,
      `quick entry: the newer bill takes the rest plus the write-off — QB2 paid ${SalesRepo.get("QB2")?.paid} (want 10500)`,
    );
    const rec = PaymentRepo.all().find((p) => p.partyId === "QP");
    assert(
      rec?.amount === 20000,
      `quick entry: the payment records the CASH taken, not the settled total — got ${rec?.amount}`,
    );
    assert(
      r2((rec?.allocations ?? []).reduce((s, a) => s + (a.discount ?? 0), 0)) === 500,
      `quick entry: the write-off is recorded as a discount — got ${JSON.stringify(rec?.allocations)}`,
    );
  }

  /* ── A rejected commit must be reported as one ───────────────────────
     Every write updates the in-memory cache the moment it is staged, so the
     screens show the new numbers before the cloud has agreed to them. When the
     commit is then rejected, Firestore rolls its own mutation back and the next
     snapshot restores the truth — but a dialog that already said "Updated 266
     items" and closed has told the shopkeeper something false, and what they
     see next looks like the app losing their work. commitBatch used to swallow
     the error, leaving callers no way to tell. */
  {
    const ok = { commit: () => Promise.resolve() } as unknown as Parameters<typeof commitBatch>[0];
    const rejected = {
      commit: () => Promise.reject(new Error("permission-denied")),
    } as unknown as Parameters<typeof commitBatch>[0];

    assert((await commitBatch(ok, "t19")) === true, "T19: a clean commit reports success");
    // The rejection is the point of the test, and commitBatch logs it — this
    // muffles the expected noise so the harness's "no console errors" rule
    // still means something for everything else.
    const realError = console.error;
    console.error = () => {};
    const rejectedResult = await commitBatch(rejected, "t19");
    console.error = realError;
    assert(rejectedResult === false, "T19: a rejected commit reports failure");
    assert((await commitBatch(null, "t19")) === true, "T19: the SSR no-op is not a failure");
  }

  /* ── Bulk Update actually writes what was typed ───────────────────────
     The client reported a bulk stock change disagreeing with the item's own
     page and the items list afterwards. This drives the real dialog the way
     a shopkeeper does — search, type, search again, type, save — and then
     checks the number on BOTH screens plus the audit trail, because those
     are the three places a stock correction has to reach.

     It also covers the flow that only a real catalogue produces: the edited
     rows are scrolled out of the window by the time Update is pressed, so a
     save that only looked at mounted rows would silently drop them. */
  {
    // Enough filler for the list to actually scroll — the window only drops a
    // row when there is something below it to scroll to, and without that the
    // "edits survive being unmounted" half of this test proves nothing.
    for (let i = 0; i < 120; i++) {
      ItemRepo.add({
        id: `FILL${i}`,
        createdAt: "2026-01-01T00:00:00Z",
        name: `Filler Item ${i}`,
        unit: "pcs",
        gstRate: 18,
        purchasePrice: 100,
        salePrice: 150,
        stock: 5,
        openingStock: 5,
      } as never);
    }
    // Added last, so these two sit at the top of the list: on page one of the
    // Items screen, and in the grid's first window until it is scrolled.
    for (const [id, stock] of [
      ["BU1", 17],
      ["BU2", 39],
    ] as const) {
      ItemRepo.add({
        id,
        createdAt: "2026-01-01T00:00:00Z",
        name: `Bulk Save ${id}`,
        unit: "pcs",
        gstRate: 18,
        purchasePrice: 100,
        salePrice: 150,
        stock,
        openingStock: stock,
      } as never);
    }

    const h = document.createElement("div");
    document.body.appendChild(h);
    const r = createRoot(h);
    await act(async () => {
      r.render(<BulkUpdateItemsDialog open onOpenChange={() => {}} onSaved={() => {}} />);
    });
    await settleMs(80);

    const stockTab = Array.from(document.querySelectorAll('[role="radio"]')).find((b) =>
      (b.textContent ?? "").trim().startsWith("Stock"),
    ) as HTMLButtonElement | undefined;
    assert(!!stockTab, "bulk save: found the Stock tab");
    await act(async () => {
      stockTab!.click();
    });
    await settleMs(60);

    const search = document.querySelector(
      'input[placeholder="Search items…"]',
    ) as HTMLInputElement | null;
    assert(!!search, "bulk save: found the search box");

    for (const [name, want] of [
      ["Bulk Save BU1", 111],
      ["Bulk Save BU2", 222],
    ] as const) {
      await act(async () => {
        setInput(search!, name);
      });
      await settleMs(60);
      const cells = gridRow(name);
      assert(!!cells, `bulk save: ${name} is findable by search`);
      if (cells) {
        await act(async () => {
          setInput(cells[1], String(want));
        });
        await settleMs(40);
      }
    }

    // Clear the search and scroll away, so NEITHER edited row is mounted when
    // Update is pressed. A save that walked the rendered rows instead of the
    // catalogue would drop both edits here and report success anyway.
    await act(async () => {
      setInput(search!, "");
    });
    await settleMs(60);
    /* EVERY scroller in the dialog, not one of them.
       The dialog mounts a desktop table AND a phone card list at once and
       hides one, and each virtualises off its own scroll position. Scrolling
       only the visible one leaves the hidden list's rows mounted, so the
       premise of this test — that neither edited row is rendered when Update
       is pressed — quietly stops being true at phone width. Found by
       structure rather than by class, so a Tailwind rename still cannot turn
       this into a no-op that passes. */
    const scrollers = Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"] *'),
    ).filter(
      (el) =>
        /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 4,
    );
    assert(scrollers.length > 0, "bulk save: found the grid scroller(s)");
    await act(async () => {
      for (const sc of scrollers) {
        sc.scrollTop = sc.scrollHeight;
        sc.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
    });
    await settleMs(120);
    /* gridRow reads the desktop TABLE, and this whole step — scroll a windowed
       list until its rows unmount — is about that table. A phone gets a card
       list which windows on its own scroller, so the premise cannot be set up
       the same way there and asserting it would be asserting nothing.

       Gated rather than deleted, and the guard asserts the table IS the live
       layout at desk width, so this can never quietly skip where the shop
       actually does its bulk edits. The rest of the block — that Update saves
       both edits — runs at every width. */
    const desktopGrid =
      !!document.querySelector<HTMLElement>('[role="dialog"] table')?.offsetParent;
    assert(
      window.innerWidth <= 480 || desktopGrid,
      "bulk save: at desk width the grid is the table this step scrolls",
    );
    if (desktopGrid) {
      assert(
        !gridRow("Bulk Save BU1") && !gridRow("Bulk Save BU2"),
        "bulk save: the edited rows really are unmounted before saving",
      );
    }

    const update = findButton(/^Update/);
    assert(
      (update?.textContent ?? "").includes("(2)"),
      `bulk save: both edits are counted — button says ${JSON.stringify(update?.textContent)}`,
    );
    await act(async () => {
      update!.click();
    });
    await settleMs(250);

    assert(
      ItemRepo.get("BU1")?.stock === 111 && ItemRepo.get("BU2")?.stock === 222,
      `bulk save: typed values land — BU1=${ItemRepo.get("BU1")?.stock} (want 111), BU2=${ItemRepo.get("BU2")?.stock} (want 222)`,
    );
    // Stock moves only through an audited adjustment, never an absolute write.
    const adjusted = StockAdjustmentRepo.all().filter(
      (a) => a.itemId === "BU1" || a.itemId === "BU2",
    );
    assert(
      adjusted.length === 2 &&
        adjusted.every((a) => a.type === "add" && a.reason === "Bulk update"),
      `bulk save: each stock change writes its audit row — got ${JSON.stringify(adjusted.map((a) => `${a.itemId}:${a.type}:${a.qty}`))}`,
    );
    // And the result must be self-consistent, or Fix Calculations would
    // "repair" a correction the shopkeeper just made on purpose.
    const drift = planStockRepair({
      items: ItemRepo.all(),
      sales: SalesRepo.all(),
      purchases: PurchaseRepo.all(),
      saleReturns: SaleReturnRepo.all(),
      purchaseReturns: [],
      stockAdjustments: StockAdjustmentRepo.all(),
    }).filter((d) => d.id === "BU1" || d.id === "BU2");
    assert(
      drift.length === 0,
      `bulk save: the corrected items must not read as drift — ${JSON.stringify(drift)}`,
    );

    r.unmount();
    h.remove();

    // The two screens the client compared.
    const itemsList = await renderRoute("/items");
    assert(itemsList.includes("111 pcs"), "bulk save: the items list shows the new stock");
    const itemPage = await renderRoute("/items/BU1");
    assert(itemPage.includes("111 pcs"), "bulk save: the item's own page shows the new stock");
    assert(
      itemPage.includes("Bulk update"),
      "bulk save: the item's history shows where the change came from",
    );
  }

  /* ── Bulk rename cannot manufacture two identical items ───────────────
     Renaming in bulk shipped with no guard, while the single-item form has
     always blocked duplicates. Two items sharing a name is precisely how the
     list and an item's own page start disagreeing about which one is which. */
  {
    const h = document.createElement("div");
    document.body.appendChild(h);
    const r = createRoot(h);
    await act(async () => {
      r.render(<BulkUpdateItemsDialog open onOpenChange={() => {}} onSaved={() => {}} />);
    });
    await settleMs(80);

    const infoTab = Array.from(document.querySelectorAll('[role="radio"]')).find((b) =>
      (b.textContent ?? "").trim().startsWith("Item Information"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      infoTab!.click();
    });
    await settleMs(60);

    const search = document.querySelector('input[placeholder="Search items…"]') as HTMLInputElement;
    await act(async () => {
      setInput(search, "Bulk Save BU2");
    });
    await settleMs(60);
    const row = gridRow("Bulk Save BU2");
    assert(!!row, "bulk rename: found the row to rename");
    // Rename it to the OTHER item's name. (Every step below re-finds the row
    // by its CURRENT name: if the guard under test is missing, the rename
    // goes through and the old handle would be stale — this must report the
    // broken guard, not crash the harness on it.)
    await act(async () => {
      setInput(row![0], "Bulk Save BU1");
    });
    await settleMs(60);
    await act(async () => {
      findButton(/^Update/)!.click();
    });
    await settleMs(200);
    assert(
      ItemRepo.get("BU2")?.name === "Bulk Save BU2",
      `bulk rename: a duplicate name is refused — BU2 is now ${JSON.stringify(ItemRepo.get("BU2")?.name)}`,
    );

    // A blank name is refused too.
    const stillThere = gridRow("Bulk Save BU1") ?? row;
    await act(async () => {
      setInput(stillThere![0], "   ");
    });
    await settleMs(60);
    await act(async () => {
      findButton(/^Update/)!.click();
    });
    await settleMs(200);
    assert(
      ItemRepo.get("BU2")?.name === "Bulk Save BU2",
      `bulk rename: a blank name is refused — BU2 is now ${JSON.stringify(ItemRepo.get("BU2")?.name)}`,
    );

    /* A legal rename made in the SAME save as a stock change: the audit row
       has to be filed under the new name. It used to copy the stored one, so
       the item's history showed a movement labelled with a name that item no
       longer had. */
    const toRename = gridRow("   ") ?? gridRow("Bulk Save BU1") ?? row;
    await act(async () => {
      setInput(toRename![0], "Bulk Save Renamed");
    });
    await settleMs(60);
    const stockTab2 = Array.from(document.querySelectorAll('[role="radio"]')).find((b) =>
      (b.textContent ?? "").trim().startsWith("Stock"),
    ) as HTMLButtonElement;
    await act(async () => {
      stockTab2.click();
    });
    await settleMs(60);
    const renamedRow = gridRow("Bulk Save Renamed");
    assert(!!renamedRow, "bulk rename: the renamed row keeps its edit across tabs");
    if (renamedRow) {
      await act(async () => {
        setInput(renamedRow[1], "500");
      });
      await settleMs(60);
    }
    await act(async () => {
      findButton(/^Update/)!.click();
    });
    await settleMs(250);
    assert(
      ItemRepo.get("BU2")?.name === "Bulk Save Renamed" && ItemRepo.get("BU2")?.stock === 500,
      `bulk rename: a legal rename saves alongside the stock change — ${JSON.stringify(ItemRepo.get("BU2")?.name)} / ${ItemRepo.get("BU2")?.stock}`,
    );
    const renameAdj = StockAdjustmentRepo.all().filter((a) => a.itemId === "BU2");
    assert(
      renameAdj.some((a) => a.itemName === "Bulk Save Renamed"),
      `bulk rename: the audit row carries the NEW name — got ${JSON.stringify(renameAdj.map((a) => a.itemName))}`,
    );

    r.unmount();
    h.remove();
  }

  /* ── A search survives opening a result and coming back ───────────────
     "I searched, opened one, pressed back, and it had forgotten everything."
     The list's search was component state, so it died with the unmount. */
  {
    const list = await renderRoute("/items");
    const box = document.querySelector('input[placeholder*="Search"]') as HTMLInputElement | null;
    assert(!!box, `sticky search: found the items search box — page has ${list.length} chars`);
    if (box) {
      await act(async () => {
        setInput(box, "Bulk Save BU1");
      });
      await settleMs(80);
      // Leave and come back the way the client does: open a result, return.
      await renderRoute("/items/BU1");
      const backAgain = await renderRoute("/items");
      const box2 = document.querySelector(
        'input[placeholder*="Search"]',
      ) as HTMLInputElement | null;
      assert(
        box2?.value === "Bulk Save BU1",
        `sticky search: the search is still there on return — got ${JSON.stringify(box2?.value)}`,
      );
      assert(
        backAgain.includes("Bulk Save BU1"),
        "sticky search: and the list is still filtered by it",
      );
      // Clearing it must actually clear it — remembered state, not stuck state.
      await act(async () => {
        setInput(box2, "");
      });
      await settleMs(60);
      await renderRoute("/items/BU1");
      await renderRoute("/items");
      const box3 = document.querySelector(
        'input[placeholder*="Search"]',
      ) as HTMLInputElement | null;
      assert(box3?.value === "", "sticky search: clearing it sticks too");
    }
  }

  /* ── Back is ONE step, by key as well as by button ────────────────────
     The detail pages used to navigate FORWARD to their list, which pushes a
     new history entry — so the browser's own Back button then returned to
     the detail page and the user was stuck in a loop. */
  {
    // Arrive at the item from the PARTIES page, so "back" has somewhere real
    // to go and we can prove it goes THERE — not to the items list, which is
    // what the old forward-navigation did regardless of where you came from.
    const detail = await renderRoute(["/parties", "/items/BU1"]);
    assert(detail.includes("Bulk Save BU1"), "back: the item detail page rendered");

    const backBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Go back",
    );
    assert(!!backBtn, "back: the detail page has a back button");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    const afterEsc = await readMounted();
    assert(!afterEsc.includes("Bulk Save BU1"), "back: Escape leaves the detail page");
    assert(
      afterEsc.includes("customers / suppliers"),
      `back: Escape returns to where we CAME FROM (parties), not the items list — landed on ${JSON.stringify(afterEsc.slice(0, 120))}`,
    );

    // Backspace is the other habit, and must behave identically.
    const detail2 = await renderRoute(["/parties", "/items/BU1"]);
    assert(detail2.includes("Bulk Save BU1"), "back: mounted the detail page again");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    });
    const afterBksp = await readMounted();
    assert(!afterBksp.includes("Bulk Save BU1"), "back: Backspace goes back too");

    // Typing must be untouchable: Backspace in a text box deletes a
    // character, it does not leave the page.
    const detail3 = await renderRoute(["/parties", "/items/BU1"]);
    const anyInput = document.querySelector("input") as HTMLInputElement | null;
    if (anyInput) {
      await act(async () => {
        anyInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
      });
      const afterTyping = await readMounted();
      assert(
        afterTyping.includes("Bulk Save BU1"),
        "back: Backspace while typing does NOT navigate",
      );
    } else {
      assert(detail3.length > 0, "back: (no input on the detail page to test typing with)");
    }

    // A key the shortcut must not claim.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    const afterOrdinary = await readMounted();
    assert(afterOrdinary.includes("Bulk Save BU1"), "back: an ordinary key does nothing");
  }

  /* ── Category suggests what already exists, and still takes a new one ──
     Three spellings of one shelf ("Charger", "charger", "Chargers") is what a
     free-text box produces, and it makes the category filter meaningless. */
  {
    ItemRepo.add({
      id: "CAT1",
      createdAt: "2026-01-01T00:00:00Z",
      name: "Category Probe Item",
      unit: "pcs",
      gstRate: 18,
      purchasePrice: 10,
      salePrice: 20,
      stock: 1,
      openingStock: 1,
      category: "Chargers",
    } as never);

    const h = document.createElement("div");
    document.body.appendChild(h);
    const r = createRoot(h);
    await act(async () => {
      r.render(<BulkUpdateItemsDialog open onOpenChange={() => {}} onSaved={() => {}} />);
    });
    await settleMs(80);
    const infoTab = Array.from(document.querySelectorAll('[role="radio"]')).find((b) =>
      (b.textContent ?? "").trim().startsWith("Item Information"),
    ) as HTMLButtonElement;
    await act(async () => {
      infoTab.click();
    });
    await settleMs(60);
    const search = document.querySelector('input[placeholder="Search items…"]') as HTMLInputElement;
    await act(async () => {
      setInput(search, "Category Probe Item");
    });
    await settleMs(80);

    /* The VISIBLE copy. Two grids are mounted — a desktop table and a phone
       card list — and focus() on the hidden one is a no-op, so the picker
       never opens and the test reports a bug that is not there. */
    const catCell =
      Array.from(
        document.querySelectorAll<HTMLInputElement>(
          'input[aria-label="category for Category Probe Item"]',
        ),
      ).find((el) => el.offsetParent !== null) ?? null;
    assert(!!catCell, "category: the grid cell is a picker");
    if (catCell) {
      await act(async () => {
        catCell.focus();
      });
      await settleMs(60);
      const listbox = document.querySelector('[role="listbox"]');
      assert(!!listbox, "category: focusing opens the list of existing categories");
      assert(
        (listbox?.textContent ?? "").includes("Chargers"),
        `category: an existing category is offered — saw ${JSON.stringify(listbox?.textContent)}`,
      );

      // A value nobody has used yet is offered as an explicit "add", so a new
      // shelf is possible without the box quietly inviting duplicates.
      await act(async () => {
        setInput(catCell, "Screen Guard");
      });
      await settleMs(60);
      const addRow = document.querySelector('[role="listbox"]')?.textContent ?? "";
      assert(
        addRow.includes("Add") && addRow.includes("Screen Guard"),
        `category: a brand new value can be added — saw ${JSON.stringify(addRow)}`,
      );

      // Typing something that ALREADY exists must not offer to add it again.
      await act(async () => {
        setInput(catCell, "Chargers");
      });
      await settleMs(60);
      assert(
        !(document.querySelector('[role="listbox"]')?.textContent ?? "").includes("Add"),
        "category: an existing value is not offered as a new one",
      );
    }
    r.unmount();
    h.remove();
  }

  /* ── The bulk ledger download is the SAME document as the party page's ──
     Selecting parties and downloading produced a cut-down six-column PDF with
     no item breakdown, while opening one party and downloading gave the full
     nine-column statement. Same words on the button, visibly different file.
     This pins the printable statement against the columns the party page
     actually shows, so the two cannot drift apart again. */
  {
    const statementParty = PartyRepo.get("P1")!;
    const built = buildPartyStatement(statementParty, {
      sales: SalesRepo.all(),
      purchases: PurchaseRepo.all(),
      saleReturns: SaleReturnRepo.all(),
      purchaseReturns: PurchaseReturnRepo.all(),
      payments: PaymentRepo.all(),
    });

    const h = document.createElement("div");
    document.body.appendChild(h);
    const r = createRoot(h);
    await act(async () => {
      r.render(
        <PrintablePartyStatement
          party={statementParty}
          rows={built.rows}
          company={CompanyRepo.get()}
          periodLabel="All transactions"
          format="full"
        />,
      );
    });
    await settleMs(60);
    const text = h.textContent ?? "";

    /* The bulk download must be the SAME document as the one a single party
       produces — that is the whole complaint it answers. Same five columns,
       same wording. */
    for (const col of ["Date", "Particulars", "You Gave", "You Got", "Balance"]) {
      assert(text.includes(col), `bulk ledger: the full PDF has the "${col}" column`);
    }
    assert(
      !text.includes("Txn Balance") && !text.includes("Payment Status"),
      "bulk ledger: and none of the columns the statement page stopped showing",
    );

    /* A summary a shop reads before the rows: what was billed, what came
       back, what is left. */
    /* Four boxes that RECONCILE — opening + gave − got = closing — so a
       reader can check the summary against itself. "Total Billed" took part
       in no such equation, and a party whose whole balance was an opening
       figure showed 0, 0, 0 and then a closing balance of 5,100 with nothing
       on the page explaining it. */
    for (const box of ["Opening Balance", "You Got", "You Gave", "Closing Balance"]) {
      assert(text.includes(box), `bulk ledger: the summary shows "${box}"`);
    }
    assert(
      text.includes("USB Cable"),
      `bulk ledger: a real line item reaches the page — ${JSON.stringify(text.slice(0, 200))}`,
    );
    // The numbers are the statement's own, not recomputed.
    const closing = built.rows.length ? built.rows[built.rows.length - 1].balance : 0;
    /* Compared without the rupee sign: the printed document drops it on
       purpose, because the headless browser that draws these PDFs has no
       font carrying it and printed a blank where it stood. The FIGURE is
       what has to match the statement, and it still does. */
    const plain = (n: number) => fmtMoney(n).replace("₹", "");
    assert(
      text.includes(plain(Math.abs(closing))),
      `bulk ledger: it closes on the statement's balance ${plain(Math.abs(closing))}`,
    );

    // The simple format stays the plain six-column ledger.
    await act(async () => {
      r.render(
        <PrintablePartyStatement
          party={statementParty}
          rows={built.rows}
          company={CompanyRepo.get()}
          periodLabel="All transactions"
          format="simple"
        />,
      );
    });
    await settleMs(60);
    const simple = h.textContent ?? "";
    assert(
      simple.includes("Particulars") && simple.includes("Credit") && simple.includes("Debit"),
      "bulk ledger: the simple format is the plain Credit/Debit ledger",
    );
    assert(
      !simple.includes("Payment Status"),
      "bulk ledger: and does NOT carry the full statement's columns",
    );
    r.unmount();
    h.remove();
  }

  /* ── Transfers: cash → bank, bank → cash, bank → bank ─────────────────
     Modelled on Vyapar, which the client already knows: one FROM and one TO,
     and the three transfers are the same action with different endpoints.
     Money leaving one account and never arriving at the other is the single
     outcome here that silently costs the shop money, so both legs go on one
     batch — and the bank-to-bank case is the one the first version could not
     do at all. */
  {
    for (const [id, name, balance] of [
      ["TB1", "Transfer Test Bank", 5000],
      ["TB2", "Second Test Bank", 800],
    ] as const) {
      BankRepo.add({
        id,
        createdAt: "2026-01-01T00:00:00Z",
        name,
        openingBalance: 0,
        balance,
      } as never);
    }

    const cashNow = () =>
      cashFlows(
        SalesRepo.all(),
        PurchaseRepo.all(),
        ExpenseRepo.all(),
        PaymentRepo.all(),
        CashAdjustmentRepo.all(),
      ).reduce((s, e) => s + e.in - e.out, 0);

    const h = document.createElement("div");
    document.body.appendChild(h);
    const r = createRoot(h);
    await act(async () => {
      r.render(<CashBankTransferDialog open onOpenChange={() => {}} onSaved={() => {}} />);
    });
    await settleMs(80);

    const dlg = document.querySelector('[role="dialog"]')!;
    assert((dlg.textContent ?? "").includes("Transfer Money"), "transfer: the dialog rendered");

    // The two ends and the swap between them are one row, so they have to
    // line up. The balance used to hang UNDER each field as loose text, which
    // left the columns different heights and pushed the swap button out of
    // line with the fields it sits between.
    {
      const fromBtn = dlg.querySelector(
        '[role="combobox"][aria-label="From account"]',
      ) as HTMLElement;
      const toBtn = dlg.querySelector('[role="combobox"][aria-label="To account"]') as HTMLElement;
      const swapBtn = dlg.querySelector('[aria-label="Swap accounts"]') as HTMLElement;
      assert(!!fromBtn && !!toBtn && !!swapBtn, "transfer: found both fields and the swap button");
      if (fromBtn && toBtn && swapBtn) {
        const f = fromBtn.getBoundingClientRect();
        const t = toBtn.getBoundingClientRect();
        const w = swapBtn.getBoundingClientRect();
        assert(
          Math.abs(f.top - t.top) < 1 && Math.abs(f.height - t.height) < 1,
          `transfer: the two account fields line up — From ${Math.round(f.top)}/${Math.round(
            f.height,
          )}, To ${Math.round(t.top)}/${Math.round(t.height)}`,
        );
        assert(
          Math.abs(f.top - w.top) < 1 && Math.abs(f.height - w.height) < 1,
          `transfer: and the swap button lines up with them — swap ${Math.round(
            w.top,
          )}/${Math.round(w.height)} vs field ${Math.round(f.top)}/${Math.round(f.height)}`,
        );
        // The balance reads inside the field it belongs to, not beside it.
        assert(
          (fromBtn.textContent ?? "").includes("₹"),
          `transfer: each field shows its own balance — ${JSON.stringify(fromBtn.textContent)}`,
        );
      }
    }

    /** Choose an account on one side of the transfer. */
    const pick = async (side: "From" | "To", accountName: string) => {
      const btn = dlg.querySelector(
        `[role="combobox"][aria-label="${side} account"]`,
      ) as HTMLButtonElement | null;
      assert(!!btn, `transfer: found the ${side} picker`);
      if (!btn) return;
      await act(async () => {
        btn.click();
      });
      await settleMs(50);
      const list = dlg.querySelector(`[role="listbox"][aria-label="${side} accounts"]`);
      assert(!!list, `transfer: the ${side} list opens as the app's own popup`);
      const option = Array.from(list?.querySelectorAll('[role="option"]') ?? []).find((o) =>
        (o.textContent ?? "").includes(accountName),
      );
      assert(!!option, `transfer: ${accountName} is offered under ${side}`);
      await act(async () => {
        option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      await settleMs(50);
      assert(
        (btn.textContent ?? "").includes(accountName),
        `transfer: ${side} now reads ${accountName} — got ${JSON.stringify(btn.textContent)}`,
      );
    };

    const enterAndSend = async (n: string) => {
      const box = dlg.querySelector(
        'input[aria-label="Transfer amount"]',
      ) as HTMLInputElement | null;
      assert(!!box, "transfer: found the amount box");
      await act(async () => {
        setInput(box, n);
      });
      await settleMs(50);
      const go = Array.from(dlg.querySelectorAll("button")).find(
        (b) => (b.textContent ?? "").trim() === "Transfer",
      );
      assert(!!go, "transfer: found the Transfer button");
      await act(async () => {
        go?.click();
      });
      await settleMs(200);
    };

    /* 1. Cash → Bank. Both sides must move, by the same amount. */
    const cashBefore = cashNow();
    // TO first, always: the picker refuses the account already chosen on
    // the other side, so setting From to what is currently To is a no-op.
    await pick("To", "Transfer Test Bank");
    await pick("From", "Cash in Hand");
    await enterAndSend("1500");
    assert(
      BankRepo.get("TB1")?.balance === 6500,
      `transfer: cash→bank raises the account — ${BankRepo.get("TB1")?.balance} (want 6500)`,
    );
    assert(
      Math.abs(cashNow() - (cashBefore - 1500)) < 0.01,
      `transfer: and lowers the drawer by the same — ${cashNow()} (want ${cashBefore - 1500})`,
    );

    /* 2. Bank → Bank: the case that previously had to be done as a manual
          withdrawal plus a manual deposit, with nothing tying them together. */
    const cashUntouched = cashNow();
    await pick("To", "Second Test Bank");
    await pick("From", "Transfer Test Bank");
    await enterAndSend("500");
    assert(
      BankRepo.get("TB1")?.balance === 6000 && BankRepo.get("TB2")?.balance === 1300,
      `transfer: bank→bank moves between the two — TB1 ${BankRepo.get("TB1")?.balance} (want 6000), TB2 ${BankRepo.get("TB2")?.balance} (want 1300)`,
    );
    assert(
      Math.abs(cashNow() - cashUntouched) < 0.01,
      "transfer: bank→bank leaves the cash drawer alone",
    );
    // One record on each account, and the note says where the money went.
    const legs = BankTxnRepo.all().filter((t) => (t.notes ?? "").includes("Second Test Bank"));
    assert(
      legs.length === 2 &&
        legs.some((t) => t.bankId === "TB1" && t.type === "withdraw") &&
        legs.some((t) => t.bankId === "TB2" && t.type === "deposit"),
      `transfer: bank→bank writes both legs — ${JSON.stringify(legs.map((t) => `${t.bankId}:${t.type}:${t.amount}`))}`,
    );

    /* 3. Bank → Cash, the other direction of the pair. */
    const cashBefore3 = cashNow();
    await pick("To", "Cash in Hand");
    await pick("From", "Second Test Bank");
    await enterAndSend("300");
    assert(
      BankRepo.get("TB2")?.balance === 1000,
      `transfer: bank→cash lowers the account — ${BankRepo.get("TB2")?.balance} (want 1000)`,
    );
    assert(
      Math.abs(cashNow() - (cashBefore3 + 300)) < 0.01,
      `transfer: and raises the drawer — ${cashNow()} (want ${cashBefore3 + 300})`,
    );

    /* 4. The same account on both sides is not a transfer. After step 3 the
          TO side is Cash, so Cash must be visible but unselectable in the
          FROM list — offered, so you can see why it is out, rather than
          silently missing. */
    const fromBtn = dlg.querySelector(
      '[role="combobox"][aria-label="From account"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fromBtn.click();
    });
    await settleMs(50);
    const cashOption = Array.from(
      dlg.querySelectorAll('[role="listbox"][aria-label="From accounts"] [role="option"]') ?? [],
    ).find((o) => (o.textContent ?? "").includes("Cash in Hand"));
    assert(!!cashOption, "transfer: the other side's account is still listed");
    assert(
      cashOption?.getAttribute("aria-disabled") === "true",
      "transfer: the account already chosen on the other side cannot be picked",
    );
    await act(async () => {
      cashOption?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await settleMs(50);
    assert(
      (fromBtn.textContent ?? "").includes("Second Test Bank"),
      `transfer: and clicking it changes nothing — From reads ${JSON.stringify(fromBtn.textContent)}`,
    );

    r.unmount();
    h.remove();
  }

  /* ── Backspace walks back along a bill line ───────────────────────────
     Billing runs left to right — item, qty, price — and Enter is the key a
     counter actually uses. It must walk ALONG that row and only leave at the
     end; sending Quantity straight to the next line skips Price, which is
     the second most important number on the bill.

     Backspace is a delete key and nothing else. It used to walk backwards
     along the row, which the shop reported as unprofessional — Shift+Tab
     already does that, everywhere, and a key that sometimes deletes and
     sometimes navigates cannot be relied on. */
  {
    await renderRoute("/sales/new");

    // Add a line by picking an item from the entry row.
    const addRow = visibleAddItemInput();
    assert(!!addRow, "step back: found the item entry row");
    if (addRow) {
      await act(async () => {
        setInput(addRow, "USB Cable");
      });
      await settleMs(80);
      await act(async () => {
        addRow.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await settleMs(120);
    }

    const row = document.querySelector("tbody tr") as HTMLTableRowElement | null;
    assert(!!row, "step back: a bill line was added");
    /* Enter-walks-along-the-row is a KEYBOARD flow, and a keyboard means a
       desk. A phone is given the card list instead, where there is no row to
       walk along. Run this where it is the layout actually in use: asserting
       it against a display:none table proves nothing in either direction,
       because focus() on a hidden input silently does nothing. */
    if (row && row.offsetParent !== null) {
      const fields = Array.from(row.querySelectorAll("input")) as HTMLInputElement[];
      assert(
        fields.length >= 2,
        `step back: the line has editable fields — found ${fields.length}`,
      );
      // Found by id, not position: HSN is now an always-present column ahead
      // of Qty (see InvoiceForm), so "the first input in the row" no longer
      // means Qty. Price is the very next field after it by column order
      // (Unit/Disc%/GST% are either off by default or come after Price).
      const qtyEl = row.querySelector('[id^="qty-"]') as HTMLInputElement | null;
      assert(!!qtyEl, "step back: found the quantity box by id");
      const qtyIdx = qtyEl ? fields.indexOf(qtyEl) : -1;
      const priceEl = qtyIdx >= 0 ? fields[qtyIdx + 1] : undefined;
      assert(!!qtyEl && !!priceEl, "step back: found qty and the field right after it");
      const qty = qtyEl as HTMLInputElement;
      const price = priceEl as HTMLInputElement;

      /* Enter walks ALONG the row. It used to send Quantity straight to the
         next blank item row, jumping clean over Price — the commonest
         keystroke in billing skipped the second most important number on the
         line, every single time. */
      await act(async () => {
        qty.focus();
        setInput(qty, "2");
      });
      await settleMs(40);
      await act(async () => {
        qty.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await settleMs(60);
      assert(document.activeElement !== qty, "row keys: Enter in Quantity moves off it");
      assert(
        row.contains(document.activeElement),
        "row keys: and stays on the SAME line instead of jumping to the next row",
      );
      assert(
        document.activeElement === price,
        `row keys: landing on Price, which Enter used to skip — landed on ${(document.activeElement as HTMLInputElement)?.className?.slice(0, 40)}`,
      );

      /* Backspace is a delete key again. The shop called the
         walk-backwards behaviour unprofessional; Shift+Tab already does it
         the way every other application does. */
      await act(async () => {
        price.focus();
        setInput(price, "");
      });
      await settleMs(40);
      await act(async () => {
        price.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
      });
      await settleMs(60);
      assert(
        document.activeElement === price,
        "row keys: Backspace in an empty box stays put rather than walking backwards",
      );

      /* Off the END of the row is where "next row" belongs. */
      const rowFields = Array.from(row.querySelectorAll("input")) as HTMLInputElement[];
      const last = rowFields[rowFields.length - 1];
      await act(async () => {
        last.focus();
      });
      await settleMs(40);
      await act(async () => {
        last.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await settleMs(80);
      assert(
        !row.contains(document.activeElement),
        "row keys: Enter on the last field of the row does move on to the next one",
      );
    }
  }

  /* ── Escape closes what is open, and only then leaves ─────────────────
     Escape was wired straight to "navigate away", so closing the item picker
     with it ALSO threw the whole bill away. */
  {
    // Arrive THROUGH the sales list, so there is somewhere to go back to.
    // With a single-entry history the app-wide Escape bails on its own and
    // this could never tell whether the form actually claimed the key.
    await renderRoute(["/sales", "/sales/new"]);

    // Put something on the bill so leaving would cost work.
    const addRow2 = visibleAddItemInput();
    if (addRow2) {
      await act(async () => {
        setInput(addRow2, "USB Cable");
      });
      await settleMs(80);
      await act(async () => {
        addRow2.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await settleMs(120);
    }
    assert(
      !!document.querySelector("tbody tr"),
      "escape: the bill has a line on it before we press Escape",
    );

    // Open the item picker on that line, then press Escape inside it.
    const nameCell = document.querySelector(
      'tbody tr [role="button"][tabindex]',
    ) as HTMLElement | null;
    assert(!!nameCell, "escape: found the item name cell");
    if (nameCell) {
      await act(async () => {
        nameCell.click();
      });
      await settleMs(80);
      const picker = document.querySelector(
        'input[placeholder="Type to change item…"]',
      ) as HTMLInputElement | null;
      assert(!!picker, "escape: the item picker opened");
      if (picker) {
        await act(async () => {
          picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        await settleMs(120);
        assert(
          !document.querySelector('input[placeholder="Type to change item…"]'),
          "escape: closes the picker",
        );
        // The whole point: the bill is still here.
        assert(
          !!document.querySelector("tbody tr"),
          "escape: and does NOT throw the bill away behind it",
        );
      }
    }
    /* On a form, Escape belongs to the FORM, not to the app-wide "go back".
       Both are window listeners and the app-wide one is registered first, so
       without an explicit claim it would win the race and leave the page
       before the form could ask about the unsaved bill. */
    {
      let asked = 0;
      const realConfirm = window.confirm;
      window.confirm = () => {
        asked++;
        return false; // "no, stay here"
      };
      try {
        await act(async () => {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        await settleMs(80);
        assert(
          asked === 1,
          `escape on a form: the form asks about the unsaved bill — asked ${asked} times`,
        );
        assert(
          !!document.querySelector('input[placeholder="Type item name to add…"]'),
          "escape on a form: declining keeps us on the BILL (not the list, which also has rows)",
        );
      } finally {
        window.confirm = realConfirm;
      }
    }
  }

  /* ── The page-level Escape guard, on its own ──────────────────────────
     The bill test above proves the picker keeps Escape to itself. This proves
     the OTHER half — that the page listener also refuses an Escape something
     nearer already handled. Both layers are needed: relying on the popup to
     call stopPropagation means one picker written without it silently gets
     "Escape throws the invoice away" back, and that is exactly how this bug
     existed in the first place. */
  {
    // Land on a page with no unsaved form first: the previously mounted
    // route stays in the DOM, and a dirty bill form left there would answer
    // this Escape with its own confirm() before the probe ever sees it.
    await renderRoute("/items");
    let left = 0;
    let dirty = false;
    function EscProbe() {
      useEscapeToLeave(
        () => {
          left++;
        },
        () => dirty,
      );
      return <input aria-label="esc probe" />;
    }
    const h = document.createElement("div");
    document.body.appendChild(h);
    const r = createRoot(h);
    await act(async () => {
      r.render(<EscProbe />);
    });
    await settleMs(40);

    const press = async (init?: KeyboardEventInit & { handled?: boolean }) => {
      const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      if (init?.handled) ev.preventDefault();
      await act(async () => {
        window.dispatchEvent(ev);
      });
      await settleMs(20);
    };

    await press();
    assert(left === 1, `escape guard: a clean Escape leaves the page — fired ${left}`);

    // Already handled by something nearer the keyboard.
    await press({ handled: true });
    assert(left === 1, `escape guard: an Escape a popup already handled is ignored — ${left}`);

    // A dialog owns Escape while it is open.
    const fake = document.createElement("div");
    fake.setAttribute("role", "dialog");
    document.body.appendChild(fake);
    await press();
    assert(left === 1, `escape guard: an open dialog keeps Escape to itself — ${left}`);
    fake.remove();

    // Unsaved work asks first, and "cancel" means stay.
    dirty = true;
    const realConfirm = window.confirm;
    window.confirm = () => false;
    await press();
    assert(left === 1, `escape guard: declining the prompt stays on the page — ${left}`);
    window.confirm = () => true;
    await press();
    assert(left === 2, `escape guard: accepting it leaves — ${left}`);
    window.confirm = realConfirm;

    r.unmount();
    h.remove();
  }

  /* ── Escape closes the screen on EVERY page, not just detail pages ────
     It used to be wired to the back chevron, so the same key did something on
     a bill and nothing at all on the Items list. One key, one meaning. */
  {
    // A list page — no back chevron anywhere on it, by the client's own
    // instruction, yet Escape must still step back.
    const list = await renderRoute(["/parties", "/items"]);
    assert(list.includes("Items"), "escape anywhere: the items list mounted");
    assert(
      !Array.from(document.querySelectorAll("button")).some(
        (b) => b.getAttribute("aria-label") === "Go back",
      ),
      "escape anywhere: the list has no back button (main pages must not grow one)",
    );
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    const after = await readMounted();
    assert(
      after.includes("customers / suppliers"),
      `escape anywhere: Escape still goes back from a list — landed on ${JSON.stringify(
        after.slice(0, 90),
      )}`,
    );

    // Nothing behind the page: Escape must do nothing rather than try to
    // close the tab, which a page cannot do and should not attempt on a till.
    const alone = await renderRoute("/items");
    assert(alone.includes("Items"), "escape anywhere: mounted with no history behind it");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    const stillThere = await readMounted();
    assert(
      stillThere.includes("Items"),
      "escape anywhere: with nowhere to go back to, Escape leaves the page alone",
    );

    // And it stays out of the way while someone is typing.
    const back2 = await renderRoute(["/parties", "/items"]);
    assert(back2.includes("Items"), "escape anywhere: mounted again for the typing check");
    const search = document.querySelector(
      'input[placeholder*="Search"]',
    ) as HTMLInputElement | null;
    if (search) {
      await act(async () => {
        search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      const typed = await readMounted();
      assert(
        typed.includes("Items"),
        "escape anywhere: Escape in a search box does not leave the page",
      );
    }
  }

  /* ── Escape closes the open TAB ───────────────────────────────────────
     The app keeps its own Chrome-style tab strip, so "close this screen"
     means that tab — the same thing its × does — and you land on the tab
     that takes its place rather than wherever browser history happened to
     be. Escape used to step back through history instead, which left the
     tab sitting in the strip after the screen behind it had changed. */
  {
    const restore = useWorkspace.getState();
    try {
      useWorkspace.setState({
        tabs: [
          { id: "/parties", title: "Parties", path: "/parties" },
          { id: "/items/BU1", title: "Bulk Save BU1", path: "/items/BU1" },
        ],
        activeId: "/items/BU1",
      });
      const detail = await renderRoute(["/parties", "/items/BU1"]);
      assert(detail.includes("Bulk Save BU1"), "esc tab: the detail page is open");

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      const after = await readMounted();

      const left = useWorkspace.getState().tabs.map((t) => t.id);
      assert(
        !left.includes("/items/BU1"),
        `esc tab: the tab is actually closed — strip still holds ${JSON.stringify(left)}`,
      );
      assert(left.includes("/parties"), "esc tab: the other tab is left alone");
      assert(
        useWorkspace.getState().activeId === "/parties",
        `esc tab: the neighbouring tab becomes active — got ${useWorkspace.getState().activeId}`,
      );
      assert(
        after.includes("customers / suppliers"),
        `esc tab: and the screen follows it — landed on ${JSON.stringify(after.slice(0, 90))}`,
      );

      // Three tabs, closing the FIRST one: you land on the tab that takes
      // its slot, not on the far end of the strip. With only two tabs open
      // those two rules give the same answer, so this needs three.
      useWorkspace.setState({
        tabs: [
          { id: "/parties", title: "Parties", path: "/parties" },
          { id: "/items", title: "Items", path: "/items" },
          { id: "/payments", title: "Payments", path: "/payments" },
        ],
        activeId: "/parties",
      });
      const adjacent = useWorkspace.getState().closeTabAndNext("/parties", "/parties");
      assert(
        adjacent === "/items",
        `esc tab: you land on the neighbouring tab, not the last one — got ${adjacent}`,
      );

      // Closing the LAST tab has nowhere to go but the dashboard, and must
      // never leave the strip pointing at a tab that is gone.
      useWorkspace.setState({
        tabs: [{ id: "/items", title: "Items", path: "/items" }],
        activeId: "/items",
      });
      const only = useWorkspace.getState().closeTabAndNext("/items", "/items");
      assert(only === "/", `esc tab: closing the last tab goes to the dashboard — got ${only}`);
      assert(
        useWorkspace.getState().tabs.length === 0 && useWorkspace.getState().activeId === null,
        "esc tab: and the strip is left empty, not pointing at a closed tab",
      );

      // Closing a tab you are NOT looking at must not move you.
      useWorkspace.setState({
        tabs: [
          { id: "/parties", title: "Parties", path: "/parties" },
          { id: "/items", title: "Items", path: "/items" },
        ],
        activeId: "/items",
      });
      const stay = useWorkspace.getState().closeTabAndNext("/parties", "/items");
      assert(stay === null, `esc tab: closing a background tab stays put — got ${stay}`);
      assert(
        useWorkspace.getState().activeId === "/items",
        "esc tab: and the screen you were on is still the active one",
      );
    } finally {
      useWorkspace.setState({ tabs: restore.tabs, activeId: restore.activeId });
    }
  }

  /* ── A party is receivable OR payable, never both ─────────────────────
     The payment dialogs worked out their outstanding one side at a time —
     sales for a receipt, purchases for a payment — and an opening balance is
     counted by both. So a party carrying ₹2,000 was offered as ₹2,000
     RECEIVABLE on Receive Payment and ₹2,000 PAYABLE on Make Payment: the
     same money, twice, in opposite directions. */
  {
    PartyRepo.add({
      id: "OB1",
      createdAt: "2026-01-01T00:00:00Z",
      name: "Opening Only Customer",
      type: "customer",
      openingBalance: 2000, // they owe us, and there are no invoices at all
    } as never);

    const openDialog = async (which: "Receive Payment" | "Make Payment") => {
      await renderRoute("/payments");
      const btn = findButton(new RegExp(which));
      assert(!!btn, `two-sided: found the ${which} button`);
      await act(async () => {
        btn?.click();
      });
      await settleMs(120);
      const box = document.querySelector(
        'input[placeholder="Type to search party…"]',
      ) as HTMLInputElement | null;
      assert(!!box, "two-sided: found the party box");
      if (!box) return "";
      await act(async () => {
        setInput(box, "Opening Only");
      });
      await settleMs(80);
      const option = Array.from(document.querySelectorAll("div"))
        .filter((d) => d.textContent === "Opening Only Customer")
        .pop();
      assert(!!option, `two-sided: the party is suggested on ${which}`);
      await act(async () => {
        option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      await settleMs(120);
      return currentDialog().textContent ?? "";
    };

    const received = await openDialog("Receive Payment");
    assert(
      received.includes(fmtMoney(2000)),
      `two-sided: a receivable opening shows on Receive Payment — ${JSON.stringify(received.slice(0, 140))}`,
    );

    const paid = await openDialog("Make Payment");
    assert(
      !paid.includes(fmtMoney(2000)),
      `two-sided: and NOT as a payable on Make Payment — ${JSON.stringify(paid.slice(0, 160))}`,
    );
    assert(
      paid.includes(fmtMoney(0)),
      "two-sided: Make Payment shows nothing outstanding for a party who owes US",
    );
  }

  /* ── An item can be deleted with a mouse ──────────────────────────────
     Reported as "no delete option", and that was exactly right: deleting an
     item was bound to Ctrl+Delete on a keyboard-selected row and nothing
     else. Every other action on that row had a button; this one did not, so
     for anyone working with a mouse the feature may as well not have
     existed. Parties has had a delete button all along. */
  {
    await renderRoute("/items");
    const rowOf = (name: string) =>
      Array.from(document.querySelectorAll("tbody tr")).find((tr) =>
        (tr.textContent ?? "").includes(name),
      );
    const cable = rowOf("USB Cable");
    assert(!!cable, "item delete: found the item row");
    const del = Array.from(cable?.querySelectorAll("button") ?? []).find(
      (b) => (b.getAttribute("title") ?? "") === "Delete item",
    );
    assert(!!del, "item delete: the row carries a delete button, not just a keyboard shortcut");

    /* And it still refuses when the item is on a bill — the guard was always
       right, it was simply unreachable except by keyboard. */
    const realConfirm = window.confirm;
    let asked = false;
    window.confirm = () => {
      asked = true;
      return true;
    };
    try {
      await act(async () => {
        del?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settleMs(150);
      assert(!asked, "item delete: an item used on bills is refused before anything is confirmed");
      assert(!!ItemRepo.get("I1"), "item delete: and it is still there");
    } finally {
      window.confirm = realConfirm;
    }
  }

  /* ── The grid adds its own column up ──────────────────────────────────
     Asked for so a bill can be checked against the pile of goods on the
     counter: eleven pieces there, so the bill had better say eleven. The
     printed copy has carried this line for years; the screen where the
     mistake actually gets made did not. */
  {
    await renderRoute("/sales/new");
    const add = async (name: string) => {
      const box = document.querySelector(
        'input[placeholder="Type item name to add…"]',
      ) as HTMLInputElement | null;
      await act(async () => {
        setInput(box, name);
      });
      await settleMs(120);
      await act(async () => {
        box?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await settleMs(150);
    };

    const foot = () => document.querySelector("tfoot");
    assert(!foot(), "grid total: an empty bill has nothing to total");

    await add("USB Cable");
    await add("USB Cable");
    assert(!!foot(), "grid total: a bill with lines gets a footing");

    const qtyBox = document.querySelector('[id^="qty-"]') as HTMLInputElement | null;
    assert(!!qtyBox, "grid total: found a quantity box to change");
    await act(async () => {
      setInput(qtyBox, "7");
    });
    await settleMs(150);

    const footText = foot()?.textContent ?? "";
    has(footText, "Total", "grid total: the footing says what it is");
    /* The QTY CELL, not the footing's text. Searching the text for "8" is
       satisfied by any amount that happens to contain an eight — ₹800.00
       among them — so it would pass with the quantity hard-wired to zero.
       Found by the header's own "Qty" column index, not a hardcoded
       position — HSN is now an always-present column ahead of it (see
       InvoiceForm), and a future column change shouldn't silently break
       this the same way. */
    const gridTable = foot()?.closest("table");
    const headCellsList = Array.from(gridTable?.querySelectorAll("thead th") ?? []);
    const qtyColIdx = headCellsList.findIndex((th) => th.textContent?.trim() === "Qty");
    const footCellsList = Array.from(foot()?.querySelectorAll("td") ?? []);
    assert(
      (footCellsList[qtyColIdx]?.textContent ?? "").trim() === "8",
      `grid total: the quantity column adds up — 7 and 1 should read 8, cell says ${JSON.stringify(footCellsList[qtyColIdx]?.textContent)}`,
    );

    /* The footing must survive a column being hidden, or it slides out of
       line with the header above it. Disc% and Unit are both off by default
       on this build. */
    // Both counted from the SAME table: the page holds more than one, and
    // counting across all of them compares a header to somebody else's footing.
    const headCells = gridTable?.querySelectorAll("thead th").length ?? 0;
    const footCells = foot()?.querySelectorAll("td").length ?? 0;
    assert(
      headCells === footCells,
      `grid total: the footing spans exactly the columns the header does — ${footCells} against ${headCells}`,
    );
  }

  /* ── A report can be searched, category included ──────────────────────
     Asked for on the Stock report, where Category was a column you could
     read but not search. Added to the shared table report, so every one of
     them gains it rather than the one that was complained about. */
  {
    ItemRepo.update("I1", { category: "Cables & Chargers" } as never);
    await renderRoute("/reports?r=stock");
    const page = () => document.body.textContent ?? "";
    has(page(), "Cables & Chargers", "report search: the category is on the stock report");

    const box = document.querySelector(
      'input[placeholder="Search this report…"]',
    ) as HTMLInputElement | null;
    assert(!!box, "report search: the report has a search box");

    await act(async () => {
      setInput(box, "Cables & Chargers");
    });
    await settleMs(150);
    has(page(), "USB Cable", "report search: searching a category keeps the items in it");
    has(page(), "of", "report search: and says how much of the report is being shown");

    await act(async () => {
      setInput(box, "zzz-nothing-matches-this");
    });
    await settleMs(150);
    assert(
      !(document.querySelector("tbody")?.textContent ?? "").includes("USB Cable"),
      "report search: a search that matches nothing shows nothing, rather than everything",
    );

    ItemRepo.update("I1", { category: undefined } as never);
  }

  /* ── The same item twice is two lines ─────────────────────────────────
     This shop sells phones, and two of the same model routinely go out at
     different prices on one bill — a trade-in, a haggle, a damaged box.
     Folding them into one line of quantity 2 makes that impossible to write
     down, and loses the itemisation the customer is reading. */
  {
    const addOnce = async (name: string) => {
      const box = document.querySelector(
        'input[placeholder="Type item name to add…"]',
      ) as HTMLInputElement | null;
      assert(!!box, "repeat item: found the item entry row");
      await act(async () => {
        setInput(box, name);
      });
      await settleMs(120);
      await act(async () => {
        box?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await settleMs(150);
    };
    const linesNamed = (name: string) =>
      Array.from(document.querySelectorAll('tbody [role="button"]')).filter(
        (b) => (b.textContent ?? "").trim() === name,
      ).length;

    await renderRoute("/sales/new");
    await addOnce("USB Cable");
    assert(linesNamed("USB Cable") === 1, "repeat item: the first one makes a line");
    await addOnce("USB Cable");
    assert(
      linesNamed("USB Cable") === 2,
      `repeat item: the second makes a SECOND line rather than quantity 2 — ${linesNamed("USB Cable")} line(s)`,
    );
    await addOnce("USB Cable");
    assert(linesNamed("USB Cable") === 3, "repeat item: and so does the third");

    /* Each line keeps its own price. That is the whole point — one handset
       discounted and one not, on the same bill. */
    const rows = Array.from(document.querySelectorAll("tbody tr")).filter((tr) =>
      Array.from(tr.querySelectorAll('[role="button"]')).some(
        (b) => (b.textContent ?? "").trim() === "USB Cable",
      ),
    );
    assert(rows.length === 3, "repeat item: three separate rows to price separately");
    const priceOf = (tr: Element) => {
      const inputs = Array.from(tr.querySelectorAll("input")) as HTMLInputElement[];
      return inputs[inputs.length - 1];
    };
    await act(async () => {
      setInput(priceOf(rows[0]), "90");
    });
    await settleMs(100);
    assert(
      (priceOf(rows[1]) as HTMLInputElement).value !== "90",
      "repeat item: pricing one line does not drag the others with it",
    );
  }

  /* ── Additional Charges on a purchase, the same as on a sale ──────────
     The shop pays courier/freight on goods coming in just as it charges
     freight/packing on goods going out — one named-charges list covers both,
     replacing what used to be a single unlabelled "Shipping Charge" box. */
  {
    await renderRoute("/purchase/new");
    has(
      document.body.textContent ?? "",
      "Additional Charges",
      "additional charges: a purchase can record named extra costs",
    );

    await renderRoute("/sales/new");
    has(
      document.body.textContent ?? "",
      "Additional Charges",
      "additional charges: and a sale offers the same list",
    );
  }

  /* ── Picking the wrong item is not a dead end ─────────────────────────
     Reported from the shop: choose an item by mistake, type the right name
     over it, and there was no way to create it. The blank entry row could
     add a new item; this picker could not, so the only way out was to delete
     the line and start it again.

     The half that matters is WHERE the new item lands: replacing the line
     that asked for it, not appended as a second line with the wrong item
     still sitting above it. */
  {
    await renderRoute("/sales/new");
    const addRow = visibleAddItemInput();
    assert(!!addRow, "change item: found the item entry row");
    await act(async () => {
      setInput(addRow, "USB Cable");
    });
    await settleMs(120);
    await act(async () => {
      addRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settleMs(150);

    const lineCount = () =>
      Array.from(document.querySelectorAll("tbody tr")).filter((tr) =>
        (tr.textContent ?? "").includes("₹"),
      ).length;
    const before = lineCount();
    assert(before >= 1, "change item: a line was added to work with");

    // Reopen the picker the way a person does — the name is a button.
    // A div with role="button", not a <button> — the grid styles it as a cell.
    const nameBtn = Array.from(document.querySelectorAll('tbody [role="button"]')).find(
      (b) => (b.textContent ?? "").trim() === "USB Cable",
    );
    assert(!!nameBtn, "change item: the item name is clickable to change it");
    await act(async () => {
      nameBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settleMs(120);

    const changeBox = document.querySelector(
      'input[placeholder="Type to change item…"]',
    ) as HTMLInputElement | null;
    assert(!!changeBox, "change item: the change-item picker opens");
    await act(async () => {
      setInput(changeBox, "Braided Cable 2m");
    });
    await settleMs(150);

    /* [data-opt], not any div: an ancestor wrapping only this row has the
       same textContent, and it is found first in document order — dispatching
       on it never reaches the row's own handler, so the click looks lost. */
    const addOpt = Array.from(document.querySelectorAll("[data-opt]")).find((d) =>
      (d.textContent ?? "").trim().startsWith("Add "),
    );
    assert(
      !!addOpt,
      "change item: it offers to create what was typed, instead of only saying No items found",
    );
    await act(async () => {
      addOpt?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await settleMs(180);

    const nameField = document.querySelector(
      'input[aria-label="Category for the new item"]',
    ) as HTMLInputElement | null;
    assert(!!nameField, "change item: the add-item dialog opened for it");

    const dlg = nameField?.closest('[role="dialog"]') as HTMLElement | null;
    const create = Array.from(dlg?.querySelectorAll("button") ?? []).find((b) =>
      /^Add & Continue/i.test((b.textContent ?? "").trim()),
    );
    assert(!!create, "change item: found the create button");
    await act(async () => {
      create?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settleMs(250);

    assert(
      lineCount() === before,
      `change item: the new item REPLACES the line rather than adding a second — ${before} lines became ${lineCount()}`,
    );
    const grid = document.querySelector("tbody")?.textContent ?? "";
    has(
      grid,
      "Braided Cable 2m",
      "change item: and the line now carries the item that was created",
    );
    assert(
      !grid.includes("USB Cable"),
      "change item: with the wrong item gone, not left sitting above it",
    );
  }

  /* ── Payment mode: walk the pills until one is picked, then leave ─────
     Two requests that looked contradictory and are the same rule seen from
     either side of the decision. "Stop Tab walking the pills" — once a mode
     is chosen, walking past it wastes two presses on the way to the amount.
     "Why does Tab skip Cash and Bank" — before anything is chosen, the pills
     are the whole point and Tab must reach them.

     So: nothing chosen, every pill is a Tab stop. Chosen, exactly one. */
  {
    await renderRoute("/sales/new");
    const pills = () =>
      Array.from(document.querySelectorAll('[role="radio"]')).filter((p) =>
        ["Cash", "Bank", "Credit"].includes((p.textContent ?? "").trim()),
      ) as HTMLElement[];
    assert(pills().length === 3, `mode tab: found the three payment pills — ${pills().length}`);

    /* A new bill has decided nothing. Lighting one by default is how Tab
       ends up on Credit and looks as though it skipped the other two. */
    assert(
      pills().every((p) => p.getAttribute("aria-checked") !== "true"),
      "mode tab: a new bill starts with no mode chosen",
    );
    assert(
      pills().every((p) => p.tabIndex === 0),
      `mode tab: so Tab can reach every one of them — tabbable ${pills().filter((p) => p.tabIndex === 0).length} of 3`,
    );

    /* And there is nothing after them to land on yet. This is the complaint
       in the shop's own words — "focus goes straight to Full but I have not
       selected any mode" — so it is asserted rather than left implied: no
       mode means nothing was received, which means no amount to receive it
       into. */
    const fullBtn = () =>
      Array.from(document.querySelectorAll("button")).find(
        (b) => (b.textContent ?? "").trim() === "Full",
      );
    assert(!fullBtn(), "mode tab: with no mode chosen there is no Full button to tab into");

    // Pick the one you stopped on.
    const cash = pills().find((p) => (p.textContent ?? "").trim() === "Cash")!;
    await act(async () => {
      cash.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settleMs(140);
    assert(
      pills()
        .find((p) => (p.textContent ?? "").trim() === "Cash")
        ?.getAttribute("aria-checked") === "true",
      "mode tab: picking one selects it",
    );
    assert(
      pills().filter((p) => p.tabIndex === 0).length === 1,
      `mode tab: and the group becomes ONE stop, so Tab goes to the amount — ${pills().filter((p) => p.tabIndex === 0).length} still tabbable`,
    );

    assert(!!fullBtn(), "mode tab: and once one IS chosen, Full appears for Tab to reach");

    /* Bank is the exception, deliberately: it jumps to the account box,
       because a bank payment is unusable without one. */
    const bank = pills().find((p) => (p.textContent ?? "").trim() === "Bank")!;
    await act(async () => {
      bank.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settleMs(160);
    assert(
      (document.activeElement as HTMLInputElement | null)?.placeholder === "Search bank account…",
      "mode tab: choosing Bank puts the cursor straight in the account box",
    );
  }

  /* ── An item created at the counter gets a category ───────────────────
     Reported from the shop. Adding an item from the bill form asked for
     name, unit, GST and prices but never a category, so anything created in
     the middle of billing — which is most of the catalogue, in practice —
     was invisible to every category filter afterwards and had to be found
     and re-shelved by hand later. */
  {
    ItemRepo.update("I1", { category: "Accessories" } as never);
    await renderRoute("/sales/new");

    const addRow = visibleAddItemInput();
    assert(!!addRow, "new item category: found the item entry row");
    await act(async () => {
      setInput(addRow, "Tempered Glass X99");
    });
    await settleMs(120);
    await act(async () => {
      addRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settleMs(180);

    const catBox = document.querySelector(
      'input[aria-label="Category for the new item"]',
    ) as HTMLInputElement | null;
    assert(!!catBox, "new item category: the add-item dialog asks for a category at all");

    await act(async () => {
      setInput(catBox, "Access");
    });
    await settleMs(120);
    const opt = document.querySelector('[role="listbox"] [role="option"]') as HTMLElement | null;
    assert(!!opt, "new item category: it suggests the categories already in use");
    assert(
      (opt?.textContent ?? "").trim() === "Accessories",
      `new item category: naming the existing one rather than only offering to invent one — ${JSON.stringify(opt?.textContent)}`,
    );
    await act(async () => {
      opt?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await settleMs(120);

    const before = ItemRepo.all().length;
    /* Scoped to the dialog. Searching the whole document finds "Add Sale" in
       the top bar first, which is a different button on a different screen
       and quietly makes this assert nothing. */
    const addDialog = catBox?.closest('[role="dialog"]') as HTMLElement | null;
    assert(!!addDialog, "new item category: the add-item dialog is on screen");
    const create = Array.from(addDialog?.querySelectorAll("button") ?? []).find((b) =>
      /^Add & Continue/i.test((b.textContent ?? "").trim()),
    );
    assert(!!create, "new item category: found the button that creates it");
    await act(async () => {
      create?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settleMs(200);

    assert(ItemRepo.all().length === before + 1, "new item category: the item was created");
    const made = ItemRepo.all().find((i) => i.name === "Tempered Glass X99");
    assert(!!made, "new item category: and can be found by the name that was typed");
    assert(
      made?.category === "Accessories",
      `new item category: carrying the category it was given — ${JSON.stringify(made?.category)}`,
    );

    ItemRepo.update("I1", { category: undefined } as never);
  }

  /* ── The customer's copy says how it was actually paid ────────────────
     A bill printing "Cash" when half of it went to a bank is the original
     complaint restated. The printed copy, the thermal receipt and every list
     that showed a single mode now say both parts — and name the ACCOUNT,
     because three accounts all reading "Bank" is the ambiguity this exists
     to remove. */
  {
    BankRepo.add({
      id: "BPRN",
      createdAt: "2026-01-01T00:00:00Z",
      name: "HDFC Current",
      openingBalance: 0,
      balance: 0,
    } as never);

    const splitInv = {
      id: "PRNSPL",
      createdAt: `${D4}T09:00:00Z`,
      number: "INV-PRNSPL",
      date: D4,
      partyId: "P1",
      partyName: "Ramesh Traders",
      gstEnabled: false,
      lineItems: [
        {
          id: "L",
          itemId: "I1",
          name: "USB Cable",
          unit: "pcs",
          qty: 1,
          price: 1000,
          discountPct: 0,
          gstRate: 0,
          costPrice: 0,
          amount: 1000,
        },
      ],
      subtotal: 1000,
      discount: 0,
      shippingCharge: 0,
      taxAmount: 0,
      total: 1000,
      paid: 1000,
      paymentMode: "cash",
      paidSplits: [
        { mode: "cash", amount: 400 },
        { mode: "bank", amount: 600, bankId: "BPRN" },
      ],
    } as never;

    const h = document.createElement("div");
    document.body.appendChild(h);
    const r = createRoot(h);
    const show = async (el: ReactNode) => {
      await act(async () => {
        r.render(el);
      });
      return h.textContent ?? "";
    };

    const bill = await show(
      <PrintableInvoice inv={splitInv} company={CompanyRepo.get()} mode="sale" />,
    );
    has(bill, "Cash", "printed split: the printed bill names the cash part");
    has(bill, "HDFC Current", "printed split: and names the ACCOUNT, not just the word Bank");
    has(bill, fmtMoney(400), "printed split: with how much was cash");
    has(bill, fmtMoney(600), "printed split: and how much went to the account");

    const receipt = await show(
      <ThermalReceipt inv={splitInv} company={CompanyRepo.get()} mode="sale" />,
    );
    has(receipt, "HDFC Current", "printed split: the thermal receipt says it too");
    has(receipt, fmtMoney(400), "printed split: including the cash part");

    /* An ordinary bill must read exactly as it always did — one mode, named,
       and NO amount, because "Cash ₹1,000" on a ₹1,000 bill is noise. */
    const plain = await show(
      <PrintableInvoice
        inv={{ ...splitInv, id: "PRNPLAIN", paidSplits: undefined } as never}
        company={CompanyRepo.get()}
        mode="sale"
      />,
    );
    has(plain, "Cash", "printed split: a single-mode bill still just says Cash");
    assert(!plain.includes("HDFC Current"), "printed split: with no account it never touched");

    r.unmount();
    h.remove();
  }

  /* ── A bill settled part cash, part bank ──────────────────────────────
     The reported case, driven through the real form. What matters is not
     that the rows save — it is that both halves land where they belong and
     neither is counted twice: the cash on the Cash page, the bank on that
     account's stored balance, and nothing left over. */
  {
    BankRepo.add({
      id: "BSPL",
      createdAt: "2026-01-01T00:00:00Z",
      name: "Split Test Bank",
      openingBalance: 0,
      balance: 0,
    } as never);

    await renderRoute("/sales/new");
    const partyBox = document.querySelector(
      'input[placeholder="Type name or search…"]',
    ) as HTMLInputElement | null;
    assert(!!partyBox, "split bill: found the customer box");
    await act(async () => {
      setInput(partyBox, "Ramesh Traders");
    });
    await settleMs(140);
    const pOpt = Array.from(document.querySelectorAll("div")).find(
      (d) =>
        (d.textContent ?? "").trim() === "Ramesh Traders" &&
        !d.querySelector("div div") &&
        !d.querySelector("input"),
    );
    if (pOpt) {
      await act(async () => {
        pOpt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      await settleMs(140);
    }

    const addRow = visibleAddItemInput();
    await act(async () => {
      setInput(addRow, "USB Cable");
    });
    await settleMs(120);
    await act(async () => {
      addRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settleMs(160);

    // One cable at ₹100, quantity 10 → ₹1,000, settled 400 cash + 600 bank.
    const qty = document.querySelector('[id^="qty-"]') as HTMLInputElement | null;
    assert(!!qty, "split bill: found the quantity box");
    await act(async () => {
      setInput(qty, "10");
    });
    await settleMs(140);

    /* A new bill does not start settled, and the Full shortcut only exists
       once a mode that takes money is chosen. */
    const cashPill = Array.from(document.querySelectorAll('[role="radio"]')).find(
      (p) => (p.textContent ?? "").trim() === "Cash",
    ) as HTMLElement | undefined;
    assert(!!cashPill, "split bill: found the Cash payment mode");
    await act(async () => {
      cashPill?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settleMs(140);

    const fullBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Full",
    );
    assert(!!fullBtn, "split bill: found the Full button to settle it");
    await act(async () => {
      fullBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settleMs(160);

    const splitBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      /Split across cash and bank/.test((b.textContent ?? "").trim()),
    );
    assert(!!splitBtn, "split bill: the form offers to split a settled bill");
    await act(async () => {
      splitBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settleMs(140);

    const amountBox = (n: number) =>
      document.querySelector(`input[aria-label="Amount for part ${n}"]`) as HTMLInputElement | null;
    assert(!!amountBox(1), "split bill: it opens holding the bill's own payment as one part");

    await act(async () => {
      setInput(amountBox(1), "400");
    });
    await settleMs(120);
    const addAnother = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Add another",
    );
    assert(!!addAnother, "split bill: another part can be added");
    await act(async () => {
      addAnother?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settleMs(140);

    /* Driven as the app's own dropdown, not a native <select>: open it, then
       pick the row. SelectMenu exists precisely so these do not hand their
       popup to Windows, and a test that sets .value would pass against a
       control nobody can actually use. */
    const pickFrom = async (ariaLabel: string, optionText: string) => {
      const trigger = document.querySelector(
        `[role="combobox"][aria-label="${ariaLabel}"]`,
      ) as HTMLElement | null;
      assert(!!trigger, `split bill: found the "${ariaLabel}" dropdown`);
      await act(async () => {
        trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settleMs(120);
      const list = document.querySelector(`[role="listbox"][aria-label="${ariaLabel}"]`);
      const opt = Array.from(list?.querySelectorAll('[role="option"]') ?? []).find(
        (o) => (o.textContent ?? "").trim() === optionText,
      );
      assert(!!opt, `split bill: "${optionText}" is offered in ${ariaLabel}`);
      await act(async () => {
        opt?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      });
      await settleMs(140);
    };

    await pickFrom("How part 2 was paid", "Bank");
    await pickFrom("Which account part 2 went to", "Split Test Bank");
    await act(async () => {
      setInput(amountBox(2), "600");
    });
    await settleMs(140);

    const before = SalesRepo.all().length;
    const bankBefore = BankRepo.get("BSPL")?.balance ?? 0;
    const saveBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Save",
    );

    /* A document that disagrees with itself is not a document. Try to save
       ₹400 + ₹500 against a ₹1,000 bill and it must refuse — only the person
       at the counter knows which of the two figures is the true one. */
    await act(async () => {
      setInput(amountBox(2), "500");
    });
    await settleMs(140);
    await act(async () => {
      saveBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settleMs(240);
    assert(
      SalesRepo.all().length === before,
      "split bill: parts that do not add up to the bill are refused",
    );
    assert(
      (BankRepo.get("BSPL")?.balance ?? 0) === bankBefore,
      "split bill: and nothing moved on the account while it was refused",
    );

    await act(async () => {
      setInput(amountBox(2), "600");
    });
    await settleMs(140);
    await act(async () => {
      saveBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settleMs(320);

    assert(SalesRepo.all().length === before + 1, "split bill: it saved");
    const saved = SalesRepo.all()[0];
    assert(
      (saved.paidSplits ?? []).length === 2,
      `split bill: with both parts on the record — ${JSON.stringify(saved.paidSplits)}`,
    );
    assert(
      !saved.bankId && saved.bankPaidAmount === undefined,
      "split bill: and the legacy pair left empty, so there is one answer for the money",
    );

    // The bank half moved that account's stored balance, once.
    assert(
      r2((BankRepo.get("BSPL")?.balance ?? 0) - bankBefore) === 600,
      `split bill: the bank part reached the account — ${BankRepo.get("BSPL")?.balance}`,
    );

    // The cash half reaches the Cash page, and the bank half does not.
    const flows = cashFlows(
      SalesRepo.all().filter((s) => s.id === saved.id),
      [],
      [],
      [],
      [],
    );
    assert(
      netFlow(flows) === 400,
      `split bill: the cash part reaches Cash on Hand, and only that part — ${netFlow(flows)}`,
    );

    /* THE SECOND SAVE — the path that broke on the payment and expense
       dialogs, and which a create-only test cannot see: the first save is
       correct and the damage happens on the second.

       Reopened, then genuinely EDITED — ₹400/₹600 becomes ₹300/₹700 — so the
       assertions cannot pass by the save quietly doing nothing. The account
       must follow the change exactly, and the rows must survive it. */
    {
      const bankAfterFirst = BankRepo.get("BSPL")?.balance ?? 0;
      await renderRoute(`/sales/edit/${saved.id}`);
      has(
        document.body.textContent ?? "",
        "How it was paid",
        "split re-save: reopening the bill shows it as the split it is",
      );
      const part = (n: number) =>
        document.querySelector(
          `input[aria-label="Amount for part ${n}"]`,
        ) as HTMLInputElement | null;
      assert(!!part(2), "split re-save: with both parts still there, not collapsed to one");

      await act(async () => {
        setInput(part(1), "300");
      });
      await settleMs(120);
      await act(async () => {
        setInput(part(2), "700");
      });
      await settleMs(140);

      const saveAgain = Array.from(document.querySelectorAll("button")).find(
        (b) => (b.textContent ?? "").trim() === "Save",
      );
      assert(!!saveAgain, "split re-save: found Save on the edit form");
      await act(async () => {
        saveAgain?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settleMs(340);

      const again = SalesRepo.get(saved.id);
      assert(
        JSON.stringify((again?.paidSplits ?? []).map((r) => r.amount)) === "[300,700]",
        `split re-save: the edited split is what was stored — ${JSON.stringify(again?.paidSplits)}`,
      );
      assert(
        r2((BankRepo.get("BSPL")?.balance ?? 0) - bankAfterFirst) === 100,
        `split re-save: and the account moved by exactly the difference, once — ${bankAfterFirst} then ${BankRepo.get("BSPL")?.balance}`,
      );
      assert(
        netFlow(cashFlows([again!], [], [], [], [])) === 300,
        `split re-save: with the cash half following too — ${netFlow(cashFlows([again!], [], [], [], []))}`,
      );
    }
  }

  /* ── The bank list has to follow the arrow keys ───────────────────────
     Reported from the shop: "only 3 bank account have, other nothing
     viewable". The list held every account and could be scrolled by hand —
     what it never did was follow the keyboard, so the fourth account onward
     could be highlighted and never seen. */
  {
    for (let n = 2; n <= 9; n++) {
      BankRepo.add({
        id: `BSC${n}`,
        createdAt: "2026-01-01T00:00:00Z",
        name: `Scroll Test Bank ${n}`,
        accountNumber: `00000${n}`,
        openingBalance: 0,
        balance: 0,
      } as never);
    }

    await renderRoute("/sales/new");
    const bankPill = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Bank",
    );
    assert(!!bankPill, "bank scroll: found the Bank payment mode");
    await act(async () => {
      bankPill?.click();
    });
    await settleMs(120);

    const box = document.querySelector(
      'input[placeholder="Search bank account…"]',
    ) as HTMLInputElement | null;
    assert(!!box, "bank scroll: found the bank search box");
    await act(async () => {
      box?.focus();
      box?.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    });
    await settleMs(100);

    const list = () =>
      document.querySelector("[data-bank-opt]")?.parentElement as HTMLElement | null;
    assert(!!list(), "bank scroll: the account list is open");
    assert(
      (list()?.querySelectorAll("[data-bank-opt]").length ?? 0) >= 8,
      `bank scroll: every account is in the list, not just the first few — ${list()?.querySelectorAll("[data-bank-opt]").length}`,
    );
    assert(list()?.scrollTop === 0, "bank scroll: it starts at the top");

    // Walk past the fold. The container is capped at max-h-56, so eight
    // accounts cannot all be visible at once.
    for (let n = 0; n < 8; n++) {
      await act(async () => {
        box?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
    }
    await settleMs(120);

    const scroller = list();
    assert(
      (scroller?.scrollHeight ?? 0) > (scroller?.clientHeight ?? 0),
      "bank scroll: the list is genuinely taller than its box, or this proves nothing",
    );
    assert(
      (scroller?.scrollTop ?? 0) > 0,
      `bank scroll: arrowing down the list scrolls it, instead of highlighting rows nobody can see — scrollTop ${scroller?.scrollTop}`,
    );
  }

  /* ── The category picker has to answer a mouse ────────────────────────
     Reported from the shop: in Bulk Update, the Category cell "only tab and
     enter work" — clicking a suggestion did nothing. Driven here with a real
     mousedown, which is the event the list actually listens for. */
  {
    /* An existing category to pick, so this proves SELECTING one rather than
       creating one — the "Add …" row commits the typed text either way and
       would pass even if picking were broken. */
    ItemRepo.update("I1", { category: "Accessories" } as never);

    const h = document.createElement("div");
    document.body.appendChild(h);
    const r = createRoot(h);
    await act(async () => {
      r.render(<BulkUpdateItemsDialog open onOpenChange={() => {}} onSaved={() => {}} />);
    });
    await settleMs(120);

    const infoTab = Array.from(document.querySelectorAll('[role="radio"]')).find((b) =>
      (b.textContent ?? "").trim().startsWith("Item Information"),
    ) as HTMLButtonElement | undefined;
    assert(!!infoTab, "category click: found the Item Information tab");
    await act(async () => {
      infoTab!.click();
    });
    await settleMs(100);

    /* The grid renders a desktop TABLE and a phone card list at once, one of
       them hidden by CSS. Taking [0] blindly can test the copy nobody is
       looking at — and the shop is on a desktop. */
    const allCat = Array.from(
      document.querySelectorAll('input[placeholder="Search or add…"]'),
    ) as HTMLInputElement[];
    const visibleCat = allCat.filter((el) => el.getClientRects().length > 0);
    assert(
      visibleCat.length > 0,
      `category click: a Category cell is actually on screen — ${allCat.length} exist, ${visibleCat.length} visible`,
    );
    /* Whichever layout is on screen. The visibility filter above is what
       stops the hidden copy being tested — insisting on the desktop table as
       well made this fail on a phone, where the shop also bills, and the
       thing under test (a real click can focus the box) matters on both. */
    const catBox = visibleCat[0] as HTMLInputElement | undefined;
    assert(!!catBox, "category click: found a Category cell that is on screen");

    /* A real click focuses an input through the mousedown DEFAULT ACTION.
       Anything that calls preventDefault on that mousedown leaves the box
       unfocusable by mouse while Tab still reaches it — which is exactly the
       symptom reported. Synthetic events cannot move focus, so the honest
       test is whether the default survives. */
    const md = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    catBox!.dispatchEvent(md);
    assert(
      !md.defaultPrevented,
      "category click: nothing swallows the mousedown, so a real click can focus the box",
    );
    const pd = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1 });
    catBox!.dispatchEvent(pd);
    assert(!pd.defaultPrevented, "category click: nor the pointerdown before it");

    /* And the box is actually the thing at its own coordinates. A cell
       covered by something — a sticky header, a stray portal — cannot be
       clicked at all while Tab still reaches it, which is exactly the
       reported symptom and is invisible to every other kind of assertion. */
    const box = catBox!.getBoundingClientRect();
    assert(
      box.width > 0 && box.height > 0,
      `category click: the box has a size to click — ${JSON.stringify(box)}`,
    );
    const atCentre = document.elementFromPoint(
      Math.round(box.left + box.width / 2),
      Math.round(box.top + box.height / 2),
    );
    assert(
      atCentre === catBox || catBox!.contains(atCentre),
      `category click: nothing is sitting on top of it — a click there would land on ${
        atCentre
          ? `<${atCentre.tagName.toLowerCase()} class="${(atCentre.className || "").toString().slice(0, 60)}">`
          : "nothing"
      }`,
    );

    // Focus it the way a mouse does, then type enough to bring up the list.
    await act(async () => {
      catBox!.focus();
      catBox!.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    });
    await settleMs(80);
    await act(async () => {
      setInput(catBox, "Access");
    });
    await settleMs(120);

    const listbox = document.querySelector('[role="listbox"]');
    assert(!!listbox, "category click: typing opens the suggestion list");

    /* THE ONE THAT MATTERS. A modal Radix dialog sets pointer-events:none on
       document.body while it is open, and this list is portalled to body —
       so it inherits that and becomes unclickable, while the keyboard, which
       does not care about pointer-events, keeps working perfectly.

       dispatchEvent ignores pointer-events too, which is why every earlier
       assertion here passed against broken code. elementFromPoint does NOT
       ignore it: it is the only probe in this file that answers the question
       a mouse actually asks. */
    const firstOpt = listbox?.querySelector('[role="option"]') as HTMLElement | null;
    assert(!!firstOpt, "category click: the list has an option to aim at");
    const ob = firstOpt!.getBoundingClientRect();
    const underPointer = document.elementFromPoint(
      Math.round(ob.left + ob.width / 2),
      Math.round(ob.top + ob.height / 2),
    );
    assert(
      underPointer === firstOpt || firstOpt!.contains(underPointer),
      `category click: the option is what a mouse would hit — instead the pointer finds ${
        underPointer
          ? `<${underPointer.tagName.toLowerCase()}> (body pointer-events: ${getComputedStyle(document.body).pointerEvents})`
          : "nothing"
      }`,
    );
    const option = listbox?.querySelector('[role="option"]') as HTMLElement | null;
    assert(!!option, "category click: the list has something to pick");
    const optionText = (option?.textContent ?? "").trim();

    /* A real click fires pointerdown FIRST, and that is the event Radix's
       dialog watches to decide something outside it was touched. The list is
       portalled to document.body, so it IS outside the dialog's DOM — firing
       only mousedown skips the whole interaction this bug lives in. */
    await act(async () => {
      option?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1 }),
      );
      option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      option?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      option?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settleMs(150);

    assert(
      optionText === "Accessories",
      `category click: the existing category is offered, not just "Add" — ${JSON.stringify(optionText)}`,
    );
    assert(
      catBox!.value === "Accessories",
      `category click: and clicking it fills the cell with the whole name — ${JSON.stringify(catBox!.value)}`,
    );

    /* Arriving by click must leave the box in the same state as arriving by
       Tab. Tab selects the contents; a click drops the caret where the
       pointer landed, so the next keystroke inserts into the middle of the
       existing category instead of replacing it — which is what "clicking
       does nothing, only Tab works" actually looks like from the counter. */
    {
      const other = document.querySelector(
        'input[placeholder="Search items…"]',
      ) as HTMLInputElement | null;
      assert(!!other, "category focus: found another box to come from");
      await act(async () => {
        other?.focus();
      });
      await settleMs(40);
      await act(async () => {
        catBox!.focus();
      });
      await settleMs(80);
      assert(
        document.activeElement === catBox,
        "category focus: focus really moved to the category box",
      );
      assert(
        catBox!.selectionStart === 0 && catBox!.selectionEnd === catBox!.value.length,
        `category focus: and its contents are selected, so typing replaces the category rather than inserting into it — selection ${catBox!.selectionStart}..${catBox!.selectionEnd} of ${JSON.stringify(catBox!.value)}`,
      );
    }

    r.unmount();
    h.remove();
    ItemRepo.update("I1", { category: undefined } as never);
  }

  /* ── One party, one outstanding figure, on every screen ───────────────
     Reported from the shop with these exact numbers. JAY MOBILE is both a
     customer and a supplier: ₹27,400 of unpaid sales, and ₹9,850 owed to
     them on a purchase. Their statement said ₹17,550. Receive Payment said
     ₹27,400, mentioned the difference nowhere, and offered "Full" at the
     gross — so collecting "everything owed" over-collects by exactly what the
     shop owes them back.

     Both figures were defensible on their own, which is why nothing caught
     it: the bug was that neither screen admitted the other existed. */
  {
    PartyRepo.add({
      id: "JM1",
      createdAt: "2026-01-01T00:00:00Z",
      name: "Jay Mobile Dabholi",
      type: "both",
      openingBalance: 0,
    } as never);
    const sale = (id: string, number: string, day: string, total: number, paid = 0) =>
      ({
        id,
        createdAt: `${day}T09:00:00Z`,
        number,
        date: day,
        partyId: "JM1",
        partyName: "Jay Mobile Dabholi",
        gstEnabled: false,
        lineItems: [
          {
            id: `${id}L`,
            itemId: "I1",
            name: "USB Cable",
            unit: "pcs",
            qty: 1,
            price: total,
            discountPct: 0,
            gstRate: 0,
            costPrice: 0,
            amount: total,
          },
        ],
        subtotal: total,
        discount: 0,
        shippingCharge: 0,
        taxAmount: 0,
        total,
        paid,
        paymentMode: paid ? "cash" : "credit",
      }) as never;
    // 11,000 billed with 1,100 already received leaves 9,900 — the first row
    // in the shop's screenshot.
    SalesRepo.add(sale("JMS1", "JM-0002", D2, 11000, 1100));
    SalesRepo.add(sale("JMS2", "JM-0032", D3, 3000));
    SalesRepo.add(sale("JMS3", "JM-0051", D4, 6000));
    SalesRepo.add(sale("JMS4", "JM-0131", D5, 8500));
    PurchaseRepo.add({
      id: "JMP1",
      createdAt: `${D2}T08:00:00Z`,
      number: "JMP-1",
      date: D2,
      partyId: "JM1",
      partyName: "Jay Mobile Dabholi",
      gstEnabled: false,
      lineItems: [
        {
          id: "JMP1L",
          itemId: "I1",
          name: "USB Cable",
          unit: "pcs",
          qty: 1,
          price: 9850,
          discountPct: 0,
          gstRate: 0,
          costPrice: 9850,
          amount: 9850,
        },
      ],
      subtotal: 9850,
      discount: 0,
      shippingCharge: 0,
      taxAmount: 0,
      total: 9850,
      paid: 0,
      paymentMode: "credit",
    } as never);

    await renderRoute("/payments");
    const recv = findButton(/Receive Payment/);
    assert(!!recv, "one figure: found the Receive Payment button");
    await act(async () => {
      recv?.click();
    });
    await settleMs(120);
    const box = document.querySelector(
      'input[placeholder="Type to search party…"]',
    ) as HTMLInputElement | null;
    assert(!!box, "one figure: found the party box");
    await act(async () => {
      setInput(box, "Jay Mobile");
    });
    await settleMs(100);
    const option = Array.from(document.querySelectorAll("div"))
      .filter((d) => d.textContent === "Jay Mobile Dabholi")
      .pop();
    assert(!!option, "one figure: the party is suggested");
    await act(async () => {
      option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await settleMs(150);
    const dialog = currentDialog().textContent ?? "";

    has(dialog, fmtMoney(17550), "one figure: Receive Payment shows what the party actually owes");
    // The gross is still shown — as the explanation, not as the answer.
    has(dialog, fmtMoney(27400), "one figure: with the open-bill total named");
    has(dialog, fmtMoney(9850), "one figure: and the amount the shop owes them named too");
    has(
      dialog,
      "you owe them",
      "one figure: said in words, so nobody has to work out why the two differ",
    );

    /* The assertion that matters: the statement and the dialog agree. Either
       number alone was arguable; disagreeing was not. */
    const statement = await renderRoute("/parties/JM1");
    has(statement, fmtMoney(17550), "one figure: and the party's own statement says the same");
  }

  /* ── Opening balance: the side is a choice, not the sign of a number ──
     It used to be read back off the sign, so on a NEW party — amount 0 —
     picking "payable" stored -0, and -0 < 0 is false: the button lit up
     green again the instant it was clicked and the choice appeared to do
     nothing at all. */
  {
    const h = document.createElement("div");
    document.body.appendChild(h);
    const r = createRoot(h);
    await act(async () => {
      r.render(<PartyDialog open onOpenChange={() => {}} party={null} onSaved={() => {}} />);
    });
    await settleMs(80);
    const dlg = currentDialog();

    const sideBtn = (name: string) =>
      Array.from(
        dlg.querySelectorAll(
          '[role="radiogroup"][aria-label="Opening balance side"] [role="radio"]',
        ),
      ).find((b) => (b.textContent ?? "").trim() === name) as HTMLButtonElement | undefined;

    assert(!!sideBtn("Receivable"), "opening: the sides are named Receivable…");
    assert(!!sideBtn("Payable"), "opening: …and Payable, the words used everywhere else");
    assert(
      !dlg.textContent?.includes("They owe me") && !dlg.textContent?.includes("I owe them"),
      "opening: the conversational wording is gone",
    );

    // The choice must stick with the amount still empty — the case that broke.
    await act(async () => {
      sideBtn("Payable")?.click();
    });
    await settleMs(50);
    assert(
      sideBtn("Payable")?.getAttribute("aria-checked") === "true",
      "opening: Payable can be chosen BEFORE any amount is typed",
    );
    assert(
      sideBtn("Receivable")?.getAttribute("aria-checked") === "false",
      "opening: and choosing one clears the other",
    );

    // Typing now follows the side that was chosen.
    const amt = dlg.querySelector(
      'input[aria-label="Opening balance amount"]',
    ) as HTMLInputElement | null;
    assert(!!amt, "opening: found the amount box");
    await act(async () => {
      setInput(amt, "750");
    });
    await settleMs(50);
    assert(
      (dlg.textContent ?? "").includes("Payable"),
      "opening: 750 entered under Payable reads back as payable",
    );

    // And switching sides re-signs what is already there.
    await act(async () => {
      sideBtn("Receivable")?.click();
    });
    await settleMs(50);
    assert(
      sideBtn("Receivable")?.getAttribute("aria-checked") === "true" &&
        (amt?.value ?? "") === "750",
      `opening: switching side keeps the amount — ${JSON.stringify(amt?.value)}`,
    );
    r.unmount();
    h.remove();
  }

  /* ── Rows per page: 500 by default, changed once, remembered ──────────
     1,400 items at 50 a page meant paging to find something, or reading a
     total off one page and believing it was the whole list. */
  {
    const KEY = "bz.pageSize.items";
    window.localStorage.removeItem(KEY);

    /** The rows-per-page control, which is the app's own dropdown rather than
     *  a native <select> — the OS popup ignored every colour and radius on
     *  the page, and this bar sits at the bottom where it opened over the
     *  content in its own grey and blue. */
    const perPage = () =>
      document.querySelector(
        '[role="combobox"][aria-label="Rows per page"]',
      ) as HTMLButtonElement | null;

    const list = await renderRoute("/items");
    assert(list.includes("Items"), "page size: the items list mounted");
    assert(
      !document.querySelector("select"),
      "page size: the per-page control is not a native select",
    );
    assert(!!perPage(), "page size: found the per-page control");
    assert(
      (perPage()?.textContent ?? "").includes("500"),
      `page size: and starts at 500 — reads ${JSON.stringify(perPage()?.textContent)}`,
    );

    // Open it: the choices reach past the default in both directions.
    await act(async () => {
      perPage()?.click();
    });
    await settleMs(60);
    const menu = document.querySelector('[role="listbox"][aria-label="Rows per page"]');
    assert(!!menu, "page size: the list opens as the app's own popup");
    const labels = Array.from(menu?.querySelectorAll('[role="option"]') ?? []).map((o) =>
      (o.textContent ?? "").trim(),
    );
    assert(
      labels.includes("25") && labels.includes("1000"),
      `page size: the choices span 25 to 1000 — got ${JSON.stringify(labels)}`,
    );

    // Pick one, and it is written down.
    const twentyFive = Array.from(menu?.querySelectorAll('[role="option"]') ?? []).find(
      (o) => (o.textContent ?? "").trim() === "25",
    );
    await act(async () => {
      twentyFive?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await settleMs(60);
    assert(
      window.localStorage.getItem(KEY) === "25",
      `page size: the choice is saved — stored ${JSON.stringify(window.localStorage.getItem(KEY))}`,
    );

    // Leave, come back: still 25. This is a preference, not a detail of one
    // visit, so it has to survive a reload — hence localStorage, not memory.
    await renderRoute("/parties");
    await renderRoute("/items");
    assert(
      (perPage()?.textContent ?? "").includes("25"),
      `page size: and is still there on return — reads ${JSON.stringify(perPage()?.textContent)}`,
    );

    // Per screen, not one global setting: Parties keeps its own.
    window.localStorage.removeItem(KEY);
    assert(
      window.localStorage.getItem("bz.pageSize.parties") !== "25",
      "page size: changing Items did not change Parties",
    );
  }

  /* ── Cash rows get the action that is safe for them ───────────────────
     Cash in hand is DERIVED. A manual adjustment is the only row that owns
     itself; every other line is the cash side of a bill, an expense or a
     payment, where "editing the cash" would mean editing that document while
     leaving it saying something else. */
  {
    CashAdjustmentRepo.add({
      id: "CA1",
      createdAt: "2026-01-01T00:00:00Z",
      date: D2,
      type: "add",
      amount: 700,
      reason: "Counter float",
    } as never);

    const page = await renderRoute("/cash");
    assert(page.includes("Counter float"), "cash rows: the manual entry is listed");
    // Short dates, so the Action column is not pushed off the right edge.
    assert(
      /\d{2}-\d{2}-\d{2}/.test(page),
      `cash rows: dates are the short dd-mm-yy form — ${JSON.stringify(page.slice(0, 90))}`,
    );

    const table = document.querySelector(".data-table table") as HTMLTableElement | null;
    assert(!!table, "cash rows: found the table");
    const headers = Array.from(table?.querySelectorAll("thead th") ?? []).map((th) =>
      (th.textContent ?? "").trim(),
    );
    assert(headers.includes("Action"), `cash rows: there is an Action column — ${headers}`);

    // The Action column is PINNED, so it stays put however far the rest of a
    // wide table scrolls sideways.
    // Measure a BODY cell, not the header. The header row is sticky in its
    // own right — it stays put while you scroll DOWN — so asking a <th> about
    // position answers a different question and says nothing about whether
    // the COLUMN is pinned. This assertion passed a mutation because of it.
    const lastTd = table?.querySelector("tbody tr td:last-child") as HTMLElement | null;
    const tdStyle = lastTd && getComputedStyle(lastTd);
    assert(
      tdStyle?.position === "sticky" && tdStyle?.right === "0px",
      `cash rows: the Action column is pinned to the right — position ${tdStyle?.position}, right ${tdStyle?.right}`,
    );

    // The manual row can be edited and deleted; a derived row cannot.
    const rowFor = (text: string) =>
      Array.from(table?.querySelectorAll("tbody tr") ?? []).find((tr) =>
        (tr.textContent ?? "").includes(text),
      );
    const manual = rowFor("Counter float");
    assert(!!manual, "cash rows: found the manual row");
    assert(
      !!manual?.querySelector('[title="Edit entry"]') &&
        !!manual?.querySelector('[title="Delete entry"]'),
      "cash rows: a manual entry offers Edit and Delete",
    );

    const derived = Array.from(table?.querySelectorAll("tbody tr") ?? []).find((tr) =>
      (tr.textContent ?? "").includes("INV-0001"),
    );
    if (derived) {
      assert(
        !derived.querySelector('[title="Edit entry"]'),
        "cash rows: a row that belongs to a bill is NOT editable here",
      );
      assert(
        !!derived.querySelector('[title*="open it to change it"]'),
        "cash rows: it offers to open the bill instead",
      );
    }

    // Deleting the manual entry moves cash-in-hand by exactly its amount.
    const cashBefore = cashFlows(
      SalesRepo.all(),
      PurchaseRepo.all(),
      ExpenseRepo.all(),
      PaymentRepo.all(),
      CashAdjustmentRepo.all(),
    ).reduce((s, e) => s + e.in - e.out, 0);
    const realConfirm = window.confirm;
    window.confirm = () => true;
    try {
      await act(async () => {
        (manual?.querySelector('[title="Delete entry"]') as HTMLElement)?.click();
      });
      await settleMs(150);
    } finally {
      window.confirm = realConfirm;
    }
    assert(!CashAdjustmentRepo.get("CA1"), "cash rows: the entry is gone");
    const cashAfter = cashFlows(
      SalesRepo.all(),
      PurchaseRepo.all(),
      ExpenseRepo.all(),
      PaymentRepo.all(),
      CashAdjustmentRepo.all(),
    ).reduce((s, e) => s + e.in - e.out, 0);
    assert(
      Math.abs(cashAfter - (cashBefore - 700)) < 0.01,
      `cash rows: and cash in hand drops by its amount — ${cashAfter} (want ${cashBefore - 700})`,
    );
  }

  /* ── Deleting one leg of a transfer takes the other with it ───────────
     Half a transfer is money out of one account and never into the other,
     which is the single outcome here that quietly costs the shop money. */
  {
    BankRepo.add({
      id: "XB1",
      createdAt: "2026-01-01T00:00:00Z",
      name: "Transfer Delete Bank",
      openingBalance: 0,
      balance: 2000,
    } as never);
    const transferId = "TR-TEST-1";
    CashAdjustmentRepo.add({
      id: "XCA",
      createdAt: "2026-01-01T00:00:00Z",
      date: D2,
      type: "reduce",
      amount: 400,
      reason: "Transfer Cash in Hand → Transfer Delete Bank",
      transferId,
    } as never);
    BankTxnRepo.add({
      id: "XBT",
      createdAt: "2026-01-01T00:00:00Z",
      bankId: "XB1",
      date: D2,
      type: "deposit",
      amount: 400,
      notes: "Transfer Cash in Hand → Transfer Delete Bank",
      transferId,
    } as never);
    BankRepo.adjustField("XB1", "balance", 400); // as the transfer itself would

    await renderRoute("/cash");
    const table2 = document.querySelector(".data-table table");
    const leg = Array.from(table2?.querySelectorAll("tbody tr") ?? []).find((tr) =>
      (tr.textContent ?? "").includes("Transfer Delete Bank"),
    );
    assert(!!leg, "transfer delete: the cash leg is on the Cash page");
    // A transfer leg cannot be edited on its own — the two ends would disagree.
    assert(
      (leg?.querySelector("[title]") as HTMLElement)?.getAttribute("title")?.includes("transfer"),
      "transfer delete: the row says it is part of a transfer",
    );

    const realConfirm2 = window.confirm;
    window.confirm = () => true;
    try {
      await act(async () => {
        (
          leg?.querySelector('[title="Delete this transfer from both accounts"]') as HTMLElement
        )?.click();
      });
      await settleMs(200);
    } finally {
      window.confirm = realConfirm2;
    }
    assert(!CashAdjustmentRepo.get("XCA"), "transfer delete: the cash leg is removed");
    assert(!BankTxnRepo.get("XBT"), "transfer delete: AND the bank leg with it");
    assert(
      BankRepo.get("XB1")?.balance === 2000,
      `transfer delete: the account balance is put back — ${BankRepo.get("XB1")?.balance} (want 2000)`,
    );
  }

  /* ── The bill grid carries no Unit or Disc% column ────────────────────
     The counter gives one whole-bill "Extra Discount" in the totals card, so
     a per-line Disc% is a second place to put the same thing — and the
     client's own report was that it confuses the person entering the bill.
     Unit belongs to the item and was only ever being re-typed.

     Sales dropped them first and purchases kept them, for no reason the
     person using the two forms could see. Both are checked here so they
     cannot drift apart again.

     What must NOT happen: a bill that already carries a line discount losing
     the column. That would leave an amount changing the total with nowhere
     to see or correct it — so that case keeps the column, and is checked. */
  {
    /* The EDITABLE grid, not every table on the page. The form also renders
       a hidden printable copy of the bill, which has a Unit column of its own
       and always should — a printed bill states the unit. Selecting on
       "thead th" alone read both and reported the print template's column as
       the form's. */
    const headersOf = () => {
      const grid = Array.from(document.querySelectorAll("table")).find(
        (t) => !!t.querySelector("tbody input"),
      );
      assert(!!grid, "bill columns: found the editable line grid");
      return Array.from(grid?.querySelectorAll("thead th") ?? []).map((th) =>
        (th.textContent ?? "").trim(),
      );
    };

    for (const [route, what] of [
      ["/sales/new", "sale"],
      ["/purchase/new", "purchase"],
    ] as const) {
      await renderRoute(route);
      /* The bill forms are the pages the smoke loop above cannot reach, and
         they carry the most JSX. Same check, same reason: a comment written
         without its braces is text, and React prints it. */
      assert(
        !(document.body.textContent ?? "").includes("/*"),
        `bill columns: the ${what} form is printing a JSX comment as visible text`,
      );
      const heads = headersOf();
      assert(heads.length > 0, `bill columns: the ${what} grid rendered — ${heads}`);
      assert(
        !heads.includes("Unit"),
        `bill columns: a new ${what} has no per-line Unit column — ${heads}`,
      );
      assert(!heads.includes("Disc%"), `bill columns: and no per-line Disc% column — ${heads}`);
      // The columns that must still be there, so this cannot pass by the grid
      // having failed to render at all.
      assert(
        heads.some((h) => /qty/i.test(h)) && heads.some((h) => /price|rate/i.test(h)),
        `bill columns: while Qty and Price are still there — ${heads}`,
      );
    }

    /* An older bill that already has a line discount keeps the column. The
       figure is affecting its total; hiding it would make the total
       unexplainable and uncorrectable. */
    PurchaseRepo.add({
      id: "OLDDISC",
      createdAt: "2026-01-01T00:00:00Z",
      number: "PB-DISC",
      date: D2,
      partyId: "P1",
      partyName: "Acme Traders",
      gstEnabled: false,
      lineItems: [
        {
          id: "dl",
          itemId: "I1",
          name: "Widget",
          qty: 2,
          unit: "PCS",
          price: 100,
          discountPct: 10,
          gstRate: 0,
          amount: 180,
        },
      ],
      subtotal: 200,
      discount: 0,
      taxAmount: 0,
      total: 180,
      paid: 0,
      paymentMode: "credit",
    } as never);

    await renderRoute("/purchase/edit/OLDDISC");
    const editHeads = headersOf();
    assert(
      editHeads.includes("Disc%"),
      `bill columns: a bill that already carries a line discount keeps the column — ${editHeads}`,
    );
    assert(
      !editHeads.includes("Unit"),
      `bill columns: but still no Unit column, which nothing depends on — ${editHeads}`,
    );

    /* And clearing that discount must not take the column away underneath the
       person clearing it. NumInput reports 0 for an empty box, so a rule
       computed from the live lines flips the moment Backspace empties the
       field — the column unmounts, the focused input goes with it, and the
       one value being corrected is the one that cannot be. */
    const grid = Array.from(document.querySelectorAll("table")).find(
      (t) => !!t.querySelector("tbody input"),
    );
    const discInput = Array.from(grid?.querySelectorAll("tbody input") ?? []).find(
      (i) => (i as HTMLInputElement).value === "10",
    ) as HTMLInputElement | undefined;
    assert(!!discInput, "bill columns: found the discount box holding 10");
    await act(async () => {
      setInput(discInput, "");
    });
    await settleMs(120);
    assert(
      headersOf().includes("Disc%"),
      `bill columns: emptying it keeps the column — ${headersOf()}`,
    );
    assert(
      document.body.contains(discInput!),
      "bill columns: and the box being typed in is still there to type in",
    );
  }

  /* ── A credit note carries no Unit or Disc% column either ─────────────
     Same two columns, gone for the same reasons — with one difference that
     matters. A bill is opened and edited; a credit note gets its lines by
     copying them out of the original bill AFTER the form is already open. So
     "did it arrive with a discount" cannot be answered when the form mounts,
     and the rule has to latch instead. */
  {
    const gridOf = () => {
      const grid = Array.from(document.querySelectorAll("table")).find(
        (t) => !!t.querySelector("tbody input"),
      );
      return Array.from(grid?.querySelectorAll("thead th") ?? []).map((th) =>
        (th.textContent ?? "").trim(),
      );
    };

    for (const [route, what] of [
      ["/sale-return/new", "sale return"],
      ["/purchase-return/new", "purchase return"],
    ] as const) {
      await renderRoute(route);
      const heads = gridOf();
      assert(heads.length > 0, `return columns: the ${what} grid rendered — ${heads}`);
      assert(!heads.includes("Unit"), `return columns: no Unit column on a ${what} — ${heads}`);
      assert(!heads.includes("Disc%"), `return columns: and no Disc% column — ${heads}`);
      assert(
        heads.some((h) => /qty/i.test(h)) && heads.some((h) => /price|rate/i.test(h)),
        `return columns: while Qty and Price are still there — ${heads}`,
      );
    }

    /* Loading an original bill that HAS a line discount brings the column
       back, because that figure is now on the note and changing its total.
       This is the case a mount-time rule would get wrong: the discount
       arrives long after the form opened. */
    SalesRepo.add({
      id: "RETSRC",
      createdAt: "2026-01-01T00:00:00Z",
      number: "INV-RETSRC",
      date: D2,
      partyId: "P1",
      partyName: "Acme Traders",
      gstEnabled: false,
      lineItems: [
        {
          id: "rl",
          itemId: "I1",
          name: "Widget",
          qty: 3,
          unit: "PCS",
          price: 100,
          discountPct: 20,
          gstRate: 0,
          amount: 240,
        },
      ],
      subtotal: 300,
      discount: 0,
      taxAmount: 0,
      total: 240,
      paid: 0,
      paymentMode: "credit",
    } as never);

    await renderRoute("/sale-return/new");
    assert(
      !gridOf().includes("Disc%"),
      "return columns: no Disc% column before anything is loaded",
    );

    // Find the original-bill picker and choose that invoice.
    // The box is labelled by what it searches for, not by the word
    // "invoice" — "Search INV-… to auto-load items".
    const invBox = Array.from(document.querySelectorAll("input")).find((i) =>
      /auto-load items/i.test(i.getAttribute("placeholder") ?? ""),
    ) as HTMLInputElement | undefined;
    assert(!!invBox, "return columns: found the original-bill box");
    await act(async () => {
      setInput(invBox, "INV-RETSRC");
    });
    await settleMs(150);
    // The suggestion is a div that reacts to mousedown, not a button — the
    // picker commits before the input can blur. Driven the way a person
    // drives it rather than the way it would be convenient to.
    const option = Array.from(document.querySelectorAll("div")).find(
      (el) =>
        (el.textContent ?? "").includes("INV-RETSRC") &&
        el.querySelector("span.font-mono") &&
        !el.querySelector("div div"),
    );
    assert(!!option, "return columns: the bill is offered");
    await act(async () => {
      option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await settleMs(250);

    assert(
      gridOf().includes("Disc%"),
      `return columns: loading a bill that carries a line discount brings the column back — ${gridOf()}`,
    );
    assert(!gridOf().includes("Unit"), `return columns: and Unit still stays away — ${gridOf()}`);

    /* And it latches. Clearing the discount must not unmount the box being
       cleared — the same trap the bill form had. */
    const grid = Array.from(document.querySelectorAll("table")).find(
      (t) => !!t.querySelector("tbody input"),
    );
    const discBox = Array.from(grid?.querySelectorAll("tbody input") ?? []).find(
      (i) => (i as HTMLInputElement).value === "20",
    ) as HTMLInputElement | undefined;
    assert(!!discBox, "return columns: found the discount box holding 20");
    await act(async () => {
      setInput(discBox, "");
    });
    await settleMs(120);
    assert(
      gridOf().includes("Disc%"),
      `return columns: clearing it keeps the column — ${gridOf()}`,
    );
    assert(
      document.body.contains(discBox!),
      "return columns: and the box being cleared is still there",
    );
  }

  /* ── One date format across every section's table ─────────────────────
     Cash and Payments read 22-08-26; every other list read "22 Aug 2026".
     Two formats in one application is a small thing that makes a screen feel
     unfinished — and the long one is what pushed the Action column off the
     right edge on those two tables in the first place, a width problem the
     other tables have too and simply had not hit yet.

     Checked as a set rather than one screen at a time, because "they all
     match" is the actual requirement and no single-screen assertion states
     it. */
  {
    /* Purchase Returns carries no rows from any earlier block, and a screen
       with no rows checks nothing — so it gets one. */
    PurchaseReturnRepo.add({
      id: "PRDATE",
      createdAt: "2026-01-01T00:00:00Z",
      number: "DN-DATE",
      date: D2,
      partyId: "P1",
      partyName: "Acme Traders",
      gstEnabled: false,
      lineItems: [],
      subtotal: 100,
      taxAmount: 0,
      total: 100,
    } as never);

    const SHORT = /^\d{2}-\d{2}-\d{2}$/; // 22-08-26
    /* {3,4}, not {3}: fmtDate asks Intl for a "short" month, and September
       comes back as "Sept" — the one four-letter abbreviation in English. A
       {3} here made this suite fail every September, and, worse, made the
       negative assertion below blind to a long date for that whole month. */
    const LONG = /^\d{1,2} [A-Za-z]{3,4}\.? \d{4}$/; // 22 Aug 2026 / 02 Sept 2026

    let checked = 0;
    for (const [route, label] of [
      ["/sales", "Sales"],
      ["/purchase", "Purchases"],
      ["/sale-return", "Sale Returns"],
      ["/purchase-return", "Purchase Returns"],
      ["/expenses", "Expenses"],
      ["/payments", "Payments"],
      ["/cash", "Cash"],
    ] as const) {
      await renderRoute(route);
      const table = document.querySelector(".data-table table");
      const heads = Array.from(table?.querySelectorAll("thead th") ?? []).map((th) =>
        (th.textContent ?? "").trim(),
      );
      const dateCol = heads.indexOf("Date");
      assert(dateCol >= 0, `date format: ${label} has a Date column — ${heads}`);

      const cells = Array.from(table?.querySelectorAll("tbody tr") ?? [])
        .map((tr) => (tr.querySelectorAll("td")[dateCol]?.textContent ?? "").trim())
        .filter(Boolean);
      /* Asserted, not skipped. A screen with no rows checks nothing, and
         "continue" turns that into a pass — which is exactly how the purchase
         returns screen sailed through with the long date still on it. */
      assert(cells.length > 0, `date format: ${label} has rows to check`);
      checked++;

      assert(
        cells.every((c) => SHORT.test(c)),
        `date format: ${label} shows the short form — ${JSON.stringify(cells.slice(0, 3))}`,
      );
      assert(
        !cells.some((c) => LONG.test(c)),
        `date format: and nothing on ${label} still reads the long way — ${JSON.stringify(cells.slice(0, 3))}`,
      );
    }
    assert(checked === 7, `date format: all seven section tables were checked — ${checked}`);
  }

  /* A statement handed to a customer keeps the long date. It is a document,
     not a list to scan, and "22-08-26" on something a customer reads is worse
     in a way that saving a few pixels does not pay for. */
  {
    await renderRoute("/parties/P1");
    const rows = Array.from(document.querySelectorAll("tbody tr"))
      .map((tr) => (tr.querySelector("td")?.textContent ?? "").trim())
      .filter((t) => /\d/.test(t));
    assert(rows.length > 0, "date format: the party statement has rows");
    assert(
      // Same four-letter September case as LONG above.
      rows.some((c) => /^\d{1,2} [A-Za-z]{3,4}\.? \d{4}$/.test(c)),
      `date format: a party statement still reads the long way — it is a document handed to a customer, not a list to scan — ${JSON.stringify(rows.slice(0, 3))}`,
    );
    assert(
      !rows.some((c) => /^\d{2}-\d{2}-\d{2}$/.test(c)),
      `date format: and none of its rows were switched to the short form — ${JSON.stringify(rows.slice(0, 3))}`,
    );
  }

  /* ── The summary strip reaches the table's right edge ─────────────────
     Screens hand in their own footer <tr>, counting columns by hand. Adding
     the Action column left every one of them a cell short, so the strip
     stopped before the edge — and with the last column pinned, the ROW
     BENEATH showed through the gap. That is how a totals strip ended up with
     a stray pencil and bin floating off its end. */
  {
    await renderRoute("/payments");
    const table = document.querySelector(".data-table table") as HTMLTableElement | null;
    assert(!!table, "footer: found the table");
    const colCount = table?.querySelectorAll("thead th").length ?? 0;
    const footRow = table?.querySelector("tfoot tr");
    assert(!!footRow, "footer: the totals row is rendered");

    const spanOf = (row: Element) =>
      Array.from(row.children).reduce((n, c) => n + (Number(c.getAttribute("colspan")) || 1), 0);
    assert(
      !!footRow && spanOf(footRow) === colCount,
      `footer: it covers every column — spans ${footRow && spanOf(footRow)} of ${colCount}`,
    );

    // Measured, not just counted: the strip has to reach as far right as the
    // header does, or there is a gap for the rows below to show through.
    const lastTh = table?.querySelector("thead th:last-child") as HTMLElement | null;
    const lastFootCell = footRow?.lastElementChild as HTMLElement | null;
    if (lastTh && lastFootCell) {
      assert(
        Math.abs(
          lastTh.getBoundingClientRect().right - lastFootCell.getBoundingClientRect().right,
        ) < 1.5,
        `footer: and ends where the table ends — header right ${Math.round(
          lastTh.getBoundingClientRect().right,
        )}, footer right ${Math.round(lastFootCell.getBoundingClientRect().right)}`,
      );
      // The pinned footer cell must be painted, or rows scroll under it.
      const bg = getComputedStyle(lastFootCell).backgroundColor;
      assert(
        bg !== "" && !bg.includes("rgba(0, 0, 0, 0)"),
        `footer: the pinned corner is opaque — background ${bg}`,
      );
    }

    /* WHAT IS ON TOP, asked of the browser rather than inferred — and asked
     * under the condition that actually produces the bug.
     *
     * Two earlier versions of this assertion were worthless. The first checked
     * the footer cell's background COLOUR: right colour, but a pinned body
     * cell was painted over it, so what a person saw in the footer's Action
     * corner was a row's pencil and bin. The second asked elementFromPoint
     * but on an UNSCROLLED table — nothing passes under a sticky footer until
     * the content is taller than its container, so there was nothing to be
     * covered by and the check could not fail.
     *
     * So: enough rows to overflow a short container, scrolled, then ask. */
    {
      const h3 = document.createElement("div");
      h3.style.cssText = "position:fixed;left:0;top:0;width:640px;height:340px;display:flex;";
      document.body.appendChild(h3);
      const r3 = createRoot(h3);
      await act(async () => {
        r3.render(
          <DataTable
            columns={[
              { key: "name", label: "Name", render: (r: { id: string }) => r.id },
              { key: "amount", label: "Amount", render: () => "1,000" },
              { key: "action", label: "Action", render: () => <button>edit</button> },
            ]}
            rows={Array.from({ length: 40 }, (_, i) => ({ id: `Row ${i}` }))}
            rowKey={(r) => r.id}
            footer={
              <tr>
                <td colSpan={2}>Total</td>
              </tr>
            }
          />,
        );
      });
      await settleMs(80);

      const scroller = h3.querySelector(".data-table") as HTMLElement | null;
      const table3 = h3.querySelector("table") as HTMLElement | null;
      assert(!!scroller && !!table3, "stacking: the probe table mounted");
      /* This is about a TABLE's sticky corners — a header and footer holding
         their place while rows scroll under them. A phone gets a card list
         instead and has no such corner to own, so there is nothing here to
         check at that width. Guarded rather than deleted, and the guard
         asserts the table IS shown on a desk, so this can never quietly skip
         where it matters. */
      const tableShown = !!table3 && table3.offsetParent !== null;
      assert(
        window.innerWidth <= 480 || tableShown,
        "stacking: at desk width the probe renders as a table",
      );
      if (scroller && table3 && tableShown) {
        assert(
          scroller.scrollHeight > scroller.clientHeight + 20,
          `stacking: the probe table really overflows — content ${scroller.scrollHeight} vs box ${scroller.clientHeight}`,
        );
        await act(async () => {
          scroller.scrollTop = Math.floor(scroller.scrollHeight / 3);
          scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        await settleMs(60);

        /* elementFromPoint answers about the VIEWPORT, so a corner that has
           scrolled off the right of a narrow screen returns null and reads as
           a failure when nothing is wrong. On a phone this table is wider
           than the screen and its right-hand corner genuinely is off it. The
           guard asserts the corner IS reachable at desk width, so this can
           never quietly skip where the sticky corners matter. */
        const reachable = (r: DOMRect) =>
          r.left + r.width / 2 >= 0 &&
          r.left + r.width / 2 <= window.innerWidth &&
          r.top + r.height / 2 >= 0 &&
          r.top + r.height / 2 <= window.innerHeight;

        const foot = table3.querySelector("tfoot td:last-child") as HTMLElement | null;
        assert(!!foot, "stacking: the pinned footer corner exists");
        if (foot) {
          const fr = foot.getBoundingClientRect();
          assert(
            window.innerWidth <= 480 || reachable(fr),
            "stacking: at desk width the footer corner is on screen to be probed",
          );
        }
        if (foot && reachable(foot.getBoundingClientRect())) {
          const fr = foot.getBoundingClientRect();
          const onTop = document.elementFromPoint(fr.left + fr.width / 2, fr.top + fr.height / 2);
          assert(
            !!onTop && !!onTop.closest("tfoot"),
            `stacking: the FOOTER owns its own corner while rows scroll under it — found <${onTop?.tagName.toLowerCase()}> in ${
              onTop?.closest("tfoot")
                ? "tfoot"
                : onTop?.closest("tbody")
                  ? "tbody (a row is painted over the totals)"
                  : "neither"
            }`,
          );
        }

        const head = table3.querySelector("thead th:last-child") as HTMLElement | null;
        if (head && reachable(head.getBoundingClientRect())) {
          const hr = head.getBoundingClientRect();
          const onTopHead = document.elementFromPoint(
            hr.left + hr.width / 2,
            hr.top + hr.height / 2,
          );
          assert(
            !!onTopHead && !!onTopHead.closest("thead"),
            `stacking: and the HEADER owns its corner too — found <${onTopHead?.tagName.toLowerCase()}> in ${
              onTopHead?.closest("thead")
                ? "thead"
                : onTopHead?.closest("tbody")
                  ? "tbody"
                  : "neither"
            }`,
          );
        }
      }
      r3.unmount();
      h3.remove();
    }

    // A footer that IS short gets padded out. Every screen's footer happens to
    // be right today, so nothing on a real page exercises this — but they are
    // counted by hand, and the next column added to any table would leave one
    // of them a cell short with the pinned column's row showing through the
    // gap. Worth holding still.
    {
      const h2 = document.createElement("div");
      document.body.appendChild(h2);
      const r2root = createRoot(h2);
      await act(async () => {
        r2root.render(
          <DataTable
            columns={[
              { key: "a", label: "A", render: () => "a" },
              { key: "b", label: "B", render: () => "b" },
              { key: "action", label: "Action", render: () => "x" },
            ]}
            rows={[{ id: "1" }]}
            rowKey={(r) => r.id}
            footer={
              <tr>
                <td>Total</td>
              </tr>
            }
          />,
        );
      });
      await settleMs(60);
      const shortFoot = h2.querySelector("tfoot tr");
      assert(!!shortFoot, "footer: the short-footer probe rendered");
      assert(
        (shortFoot?.children.length ?? 0) === 3,
        `footer: a one-cell footer is padded to the column count — got ${shortFoot?.children.length}`,
      );
      r2root.unmount();
      h2.remove();
    }

    // A pinned cell has to carry the row's OWN colour, or a hovered row shows
    // a white block where its buttons are.
    const firstTd = table?.querySelector("tbody tr td:last-child") as HTMLElement | null;
    assert(
      !!firstTd && getComputedStyle(firstTd).backgroundColor !== "rgba(0, 0, 0, 0)",
      `footer: pinned body cells are opaque — ${firstTd && getComputedStyle(firstTd).backgroundColor}`,
    );
  }

  /* ── An old transfer is EDITED as a whole, and both legs follow ────────
     Editing one side on its own must not happen — the cash would move and
     the account would still say the old figure. Refusing the edit was the
     safe answer but not a good one: correcting a mistyped transfer meant
     deleting it and entering it again from memory. So the pencil opens the
     TRANSFER, and saving rewrites both legs on one batch.

     Seeded WITHOUT a shared id, exactly as transfers were written before
     that field existed — those are the ones the client was being offered a
     one-sided edit of. */
  {
    BankRepo.add({
      id: "OLDB",
      createdAt: "2026-01-01T00:00:00Z",
      name: "Legacy Transfer Bank",
      openingBalance: 0,
      balance: 5000, // already includes the 1200 below
    } as never);
    const NOTE = "Transfer to Legacy Transfer Bank — OLD ENTRY";
    CashAdjustmentRepo.add({
      id: "OLDCA",
      createdAt: "2026-01-01T00:00:00Z",
      date: D2,
      type: "reduce",
      amount: 1200,
      reason: NOTE,
    } as never);
    BankTxnRepo.add({
      id: "OLDBT",
      createdAt: "2026-01-01T00:00:00Z",
      bankId: "OLDB",
      date: D2,
      type: "deposit",
      amount: 1200,
      notes: NOTE,
    } as never);

    await renderRoute("/cash");
    const legRow = () =>
      Array.from(
        document.querySelector(".data-table table")?.querySelectorAll("tbody tr") ?? [],
      ).find((tr) => (tr.textContent ?? "").includes("OLD ENTRY"));
    assert(!!legRow(), "old transfer: the leg is listed on the Cash page");

    const pencil = legRow()?.querySelector(
      '[title="Edit this transfer (both accounts)"]',
    ) as HTMLButtonElement | null;
    assert(!!pencil && !pencil.disabled, "old transfer: it CAN be edited, as a transfer");

    await act(async () => {
      pencil?.click();
    });
    await settleMs(150);
    const dlg = currentDialog();
    assert(
      (dlg.textContent ?? "").includes("Edit Transfer"),
      `old transfer: the TRANSFER editor opens, not the cash form — ${JSON.stringify(
        dlg.textContent?.slice(0, 80),
      )}`,
    );
    // Pre-filled from the pair: cash out means cash was the source.
    const sideText = (side: "From" | "To") =>
      dlg.querySelector(`[role="combobox"][aria-label="${side} account"]`)?.textContent ?? "";
    assert(
      sideText("From").includes("Cash in Hand") && sideText("To").includes("Legacy Transfer Bank"),
      `old transfer: both ends are worked out from the legs — From ${JSON.stringify(
        sideText("From"),
      )}, To ${JSON.stringify(sideText("To"))}`,
    );
    const amt = dlg.querySelector('input[aria-label="Transfer amount"]') as HTMLInputElement | null;
    assert(amt?.value === "1200", `old transfer: and the amount — got ${amt?.value}`);

    // Correct it to 900: BOTH legs and BOTH balances have to follow.
    const cashBefore = cashFlows(
      SalesRepo.all(),
      PurchaseRepo.all(),
      ExpenseRepo.all(),
      PaymentRepo.all(),
      CashAdjustmentRepo.all(),
    ).reduce((s, e) => s + e.in - e.out, 0);
    await act(async () => {
      setInput(amt, "900");
    });
    await settleMs(60);
    await act(async () => {
      (
        Array.from(dlg.querySelectorAll("button")).find(
          (b) => (b.textContent ?? "").trim() === "Transfer",
        ) as HTMLButtonElement
      )?.click();
    });
    await settleMs(250);

    const cashLegs = CashAdjustmentRepo.all().filter((a) => (a.reason ?? "").includes("OLD ENTRY"));
    const bankLegs = BankTxnRepo.all().filter((t) => (t.notes ?? "").includes("OLD ENTRY"));
    assert(
      cashLegs.length === 1 && cashLegs[0].amount === 900,
      `old transfer: the cash leg is now 900 — ${JSON.stringify(cashLegs.map((a) => a.amount))}`,
    );
    assert(
      bankLegs.length === 1 && bankLegs[0].amount === 900,
      `old transfer: and so is the bank leg — ${JSON.stringify(bankLegs.map((t) => t.amount))}`,
    );
    assert(
      BankRepo.get("OLDB")?.balance === 4700,
      `old transfer: the account moved by the DIFFERENCE only — ${BankRepo.get("OLDB")?.balance} (want 4700)`,
    );
    const cashAfter = cashFlows(
      SalesRepo.all(),
      PurchaseRepo.all(),
      ExpenseRepo.all(),
      PaymentRepo.all(),
      CashAdjustmentRepo.all(),
    ).reduce((s, e) => s + e.in - e.out, 0);
    assert(
      Math.abs(cashAfter - (cashBefore + 300)) < 0.01,
      `old transfer: and cash keeps the 300 that is no longer being moved — ${cashAfter} (want ${cashBefore + 300})`,
    );
    // Both legs now share an id, so they stay a pair from here on.
    assert(
      !!cashLegs[0].transferId && cashLegs[0].transferId === bankLegs[0].transferId,
      "old transfer: editing it also pairs the two legs properly",
    );

    // Deleting still clears both sides and puts the balance back.
    await renderRoute("/cash");
    const del = legRow()?.querySelector(
      '[title="Delete this transfer from both accounts"]',
    ) as HTMLButtonElement | null;
    assert(!!del, "old transfer: delete says it will clear both accounts");
    const realConfirm = window.confirm;
    window.confirm = () => true;
    try {
      await act(async () => {
        del?.click();
      });
      await settleMs(200);
    } finally {
      window.confirm = realConfirm;
    }
    assert(
      CashAdjustmentRepo.all().every((a) => !(a.reason ?? "").includes("OLD ENTRY")),
      "old transfer: the cash leg is removed",
    );
    assert(
      BankTxnRepo.all().every((t) => !(t.notes ?? "").includes("OLD ENTRY")),
      "old transfer: AND the bank leg with it",
    );
    assert(
      BankRepo.get("OLDB")?.balance === 3800,
      `old transfer: the account is put back — ${BankRepo.get("OLDB")?.balance} (want 3800)`,
    );
  }

  /* ── The edit dialog says what its button will do ─────────────────────── */
  {
    CashAdjustmentRepo.add({
      id: "PLAINCA",
      createdAt: "2026-01-01T00:00:00Z",
      date: D2,
      type: "add",
      amount: 500,
      reason: "Till top-up",
    } as never);
    await renderRoute("/cash");
    const t2 = document.querySelector(".data-table table");
    const plain = Array.from(t2?.querySelectorAll("tbody tr") ?? []).find((tr) =>
      (tr.textContent ?? "").includes("Till top-up"),
    );
    const edit = plain?.querySelector('[title="Edit entry"]') as HTMLButtonElement | null;
    assert(!!edit && !edit.disabled, "edit label: an ordinary entry IS editable");
    await act(async () => {
      edit?.click();
    });
    await settleMs(120);
    const dlg = currentDialog();
    assert(
      (dlg.textContent ?? "").includes("Edit Cash Entry"),
      "edit label: the dialog is titled for editing",
    );
    assert(
      (dlg.textContent ?? "").includes("Save Changes"),
      `edit label: and its button says Save Changes, not "Adjust Cash" — ${JSON.stringify(
        dlg.textContent?.slice(0, 160),
      )}`,
    );
  }

  /* ── Bulk Update with a real-sized catalogue ──────────────────────────
     The client's shop has ~1,400 items and the screen froze on open,
     because every row mounted at once and each carries several live
     inputs. It pages now — this proves only a page reaches the DOM, and
     that mounting stays fast enough to be usable. */
  for (let i = 0; i < 1400; i++) {
    ItemRepo.add({
      id: `BULK${i}`,
      createdAt: "2026-01-01T00:00:00Z",
      name: `Bulk Test Item ${i}`,
      unit: "pcs",
      gstRate: 18,
      purchasePrice: 100,
      salePrice: 150,
      stock: 5,
      openingStock: 5,
    } as never);
  }

  /* ── Picking a payment mode carries the keyboard onward ───────────────
     The shop works a MacBook with no mouse. With macOS "Keyboard
     navigation" off — the system default — Safari's Tab visits text fields
     and skips buttons, so tabbing off the Cash pill reached neither the
     Full button nor the amount, and the run simply died there. Focus is
     driven explicitly now, so it behaves the same on every browser rather
     than depending on a setting nobody at a counter will find.

     Asserted on where the focus actually lands, because that is the whole
     feature; nothing about the rendered markup would change if it broke. */
  {
    await renderRoute("/sales/new");

    const cash = document.querySelector('[data-mode="cash"]') as HTMLElement | null;
    assert(!!cash, "mode focus: the Cash pill is on a new bill");
    if (cash) {
      await act(async () => {
        cash.click();
      });
      await settleMs(80);
      const amount = document.querySelector(
        'input[aria-label="Received amount"]',
      ) as HTMLInputElement | null;
      assert(!!amount, "mode focus: the received-amount box exists");
      assert(
        document.activeElement === amount,
        "mode focus: choosing Cash puts the cursor straight on the amount — focus is on " +
          (document.activeElement
            ? document.activeElement.tagName +
              "[" +
              (document.activeElement.getAttribute("aria-label") ??
                document.activeElement.getAttribute("data-mode") ??
                document.activeElement.getAttribute("placeholder") ??
                (document.activeElement.textContent ?? "").slice(0, 24)) +
              "]"
            : "nothing"),
      );
    }

    const bank = document.querySelector('[data-mode="bank"]') as HTMLElement | null;
    assert(!!bank, "mode focus: the Bank pill is there too");
    if (bank) {
      await act(async () => {
        bank.click();
      });
      await settleMs(80);
      // Bank asks a question Cash does not, so the cursor goes there instead.
      const bankBox = document.querySelector(
        'input[placeholder="Search bank account…"]',
      ) as HTMLInputElement | null;
      assert(!!bankBox, "mode focus: choosing Bank reveals the account box");
      assert(
        document.activeElement === bankBox,
        "mode focus: and the cursor is in it, not left on the pill",
      );

      /* The account list is absolutely positioned inside the totals card.
         That card was overflow-hidden, so every option past its bottom edge
         was clipped away — reported as a list that would not scroll. */
      const list = bankBox?.parentElement?.querySelector("[class*='overflow-auto']");
      if (list) {
        let clipped = false;
        for (let el = list.parentElement; el; el = el.parentElement) {
          if (el === document.body) break;
          if (getComputedStyle(el).overflow === "hidden") {
            clipped = true;
            break;
          }
        }
        assert(!clipped, "mode focus: no ancestor clips the bank list away");
      }
    }
  }

  /* ── Ticking a bill selects it, and does NOT open it ──────────────────
     The sales table opens the bill on row click. A checkbox dropped into
     that row inherits the click unless it stops it, so the first tick would
     navigate away — taking the selection with it. Cheap to get wrong,
     invisible in the markup, and the whole feature is unusable if it is. */
  {
    await renderRoute("/sales");

    const tick = document.querySelector(
      'input[type="checkbox"][aria-label^="Select "]',
    ) as HTMLInputElement | null;
    assert(!!tick, "invoice select: the sales list has a tick box per row");

    if (tick) {
      await act(async () => {
        tick.click();
      });
      await settleMs(120);

      /* A memory router keeps window.location fixed, so the URL proves
         nothing here. The list surviving does: navigating to the bill would
         unmount the row this box lives in. */
      assert(
        tick.isConnected,
        "invoice select: ticking stays on the list instead of opening the bill",
      );
      assert(tick.checked, "invoice select: and the row is actually selected");

      const body = document.body.textContent ?? "";
      assert(
        /1 selected/.test(body),
        "invoice select: the bulk bar appears and counts the selection",
      );
      assert(
        !!findButton(/Download 1/),
        "invoice select: with a Download button for what is ticked",
      );

      /* The bar is absent until something is ticked — an always-present strip
         of nothing is what makes a list feel cluttered. */
      await act(async () => {
        tick.click();
      });
      await settleMs(120);
      assert(
        !/1 selected/.test(document.body.textContent ?? ""),
        "invoice select: and it goes away again when nothing is ticked",
      );
    }
  }

  /* ── The bottom of the bill really is three columns ───────────────────
     It was two blocks in a three-column grid — one wide card carrying both
     the amount breakdown AND the whole payment section, then Notes. Asked
     for three, told it was three, and it was not. Stacked like that the card
     also grew tall enough to push the payment rows under the sticky Save
     bar on a laptop.

     Counted rather than eyeballed, because the count is the claim. The
     widths themselves are gated at lg: and this browser is 800px wide, so
     nothing here can speak to how it LOOKS — only to how many pieces there
     are, which is what was actually wrong. */
  {
    await renderRoute("/sales/new");

    const rows = Array.from(document.querySelectorAll('div[class*="grid-cols-3"]')).filter((el) =>
      (el.textContent ?? "").includes("Subtotal"),
    );
    assert(rows.length === 1, "three columns: found the bill's bottom row");

    if (rows[0]) {
      const cols = Array.from(rows[0].children);
      assert(
        cols.length === 3,
        "three columns: money, payment and notes are three separate cards — got " + cols.length,
      );
      /* Each one holds its own thing, so a later merge back into one wide
         card fails here rather than silently undoing this. */
      const text = cols.map((c) => c.textContent ?? "");
      assert(
        text.some((t) => t.includes("Subtotal") && t.includes("Total")),
        "three columns: one column carries the amounts",
      );
      assert(
        text.some((t) => t.includes("Payment Mode")),
        "three columns: another carries the payment",
      );
      assert(
        text.some((t) => t.includes("Notes")),
        "three columns: and the third the notes",
      );
      assert(
        !text.some((t) => t.includes("Subtotal") && t.includes("Payment Mode")),
        "three columns: the amounts and the payment are not stacked in one card again",
      );
    }
  }

  /* ── The party statement reads without an accountant ──────────────────
     "This is so hard to understand for uneducated people." It carried nine
     columns, three of which were running balances — Txn Balance, Receivable
     Balance, Payable Balance — and closed with a figure marked Dr, which
     means nothing to the person this is handed to.

     Eight columns now, one balance, and the closing figure says in words
     whose money it is. Asserted on what is actually on the page, because
     every one of these is a thing the shop looks for and would notice gone. */
  {
    const stmt = await renderRoute("/parties/P1");

    /* Two money columns and a balance, which is the shape of every
       hand-written khata in the country. Eight columns of Quantity / Rate /
       Amount put a bill's internals on the same line as the running account
       and made a month of trading unreadable. */
    for (const heading of ["Date", "Particulars", "You Gave", "You Got", "Balance"]) {
      has(stmt, heading, "statement: the column named " + heading);
    }
    /* Scoped to the header, not the page: "Quantity" legitimately appears
       inside an opened breakdown and on the mobile card, and asserting
       against the whole document fails for the wrong reason. */
    const head = document.querySelector("table thead")?.textContent ?? "";
    assert(
      head.length > 0 && !head.includes("Quantity") && !head.includes("Reference No."),
      "statement: a bill's internals are no longer columns of the account — " + head,
    );

    /* The detail is folded away, not thrown away. Seven item lines under
       every sale is what turned this into six screens of scrolling. */
    /* Tied to the data rather than assumed: a breakdown is offered only for
       a bill this row cannot already describe in full, so requiring one
       unconditionally just asserts what the seed happens to contain. */
    const hasMultiItemRow = /d+ items/.test(stmt);
    assert(
      !hasMultiItemRow || stmt.includes("View details"),
      "statement: a bill with several items offers its breakdown",
    );
    const anyItemLine = /S22U LCD TAPE|SM A16 NEW WITH FRAME LCD/.test(stmt);
    assert(!anyItemLine, "statement: but it starts closed, so the account reads as an account");

    /* The three that had to go. "Dr" is the clearest example of the whole
       complaint: correct, conventional, and unreadable to this shop. */
    assert(
      !stmt.includes("Txn Balance") && !stmt.includes("Receivable Balance"),
      "statement: the three competing balance columns are gone",
    );
    assert(!/\bDr\b/.test(stmt) && !/\bCr\b/.test(stmt), "statement: and so is Dr / Cr");

    /* What replaced them: the same fact, in a sentence. */
    assert(
      /Total amount (they owe you|you owe them)|Nothing outstanding/.test(stmt),
      "statement: the closing balance says whose money it is, in words",
    );
    has(stmt, "Closing Balance", "statement: and still calls it the closing balance");

    /* A receipt applied to several bills used to print every number in the
       reference cell and push the columns after it off the screen. */
    const longRef = Array.from(document.querySelectorAll("td[title]")).find(
      (td) => (td.getAttribute("title") ?? "").split(",").length > 2,
    );
    if (longRef) {
      assert(
        (longRef.textContent ?? "").includes("more"),
        "statement: a payment settling many bills is summarised, not printed in full",
      );
    }
  }

  /* ── Filters live behind one button, on every screen ──────────────────
     The date range, the customer picker and four status pills used to sit
     across the toolbar. It is the first row to wrap on a laptop, and every
     one of those controls was already duplicated inside the filter dialog
     the mobile button opened. They live in the dialog only now.

     Asserted from both sides: gone from the toolbar, present once the
     button is pressed. Only checking one half would pass for a page that had
     simply lost its filters. */
  for (const url of ["/sales", "/purchase"]) {
    await renderRoute(url);

    const before = document.body.textContent ?? "";
    assert(before.includes("Filters"), url + ": there is a Filters button");
    assert(
      !/\bPartial\b/.test(before),
      url + ": the status pills are not strewn across the toolbar any more",
    );

    const btn = findButton(/^Filters$/);
    assert(!!btn, url + ": the Filters button is reachable");
    if (btn) {
      await act(async () => {
        btn.click();
      });
      await settleMs(150);

      const open = document.body.textContent ?? "";
      for (const control of ["Paid", "Partial", "Unpaid"]) {
        assert(open.includes(control), url + ": the dialog offers " + control);
      }
      assert(
        document.querySelectorAll('input[type="date"]').length >= 2,
        url + ": and the date range is in there with them",
      );
    }
  }

  /* ── A statement row never repeats itself ─────────────────────────────
     A one-item bill printed its item on the row AND again, verbatim, on a
     line underneath: same name, same quantity, same rate, same amount. A
     payment row managed it too — the pill said "Payment Received" and the
     description said "Payment Received" right beside it.

     The breakdown exists to explain a row that cannot explain itself. One
     item fits on its own row and needs no second line. Asserted structurally
     rather than by counting text, because the rule is about adjacency: no
     row may be followed by a line that just says it again. */
  {
    await renderRoute("/parties/P1");

    const body = document.querySelector("table tbody");
    assert(!!body, "statement dupes: the statement table rendered");

    if (body) {
      const rows = Array.from(body.querySelectorAll("tr"));
      let repeats = 0;
      let example = "";
      for (let i = 0; i < rows.length - 1; i++) {
        const cells = rows[i].querySelectorAll("td");
        // A transaction row has the full set of columns; a breakdown line
        // has two (a spacer and a wide cell).
        if (cells.length < 5) continue;
        const description = (cells[1].textContent ?? "").trim();
        if (!description) continue;
        const next = rows[i + 1];
        if (next.querySelectorAll("td").length >= 5) continue; // another txn
        const detail = (next.textContent ?? "").trim();
        if (detail.includes(description) && description.length > 3) {
          repeats++;
          example = description;
        }
      }
      assert(
        repeats === 0,
        "statement dupes: no row is followed by a line repeating it — " +
          repeats +
          " found, e.g. " +
          example,
      );

      /* And the description of a row with no items of its own says where the
         money went, which is the question that row is actually asked. */
    }
  }

  /* ── Whatever a PDF is built from must survive the print stylesheet ────
     The party statement downloaded as two completely blank pages. No error,
     nothing in the console — just white.

     buildPrintableHtml takes ONE element's outerHTML, with no ancestors, and
     ships the app stylesheet alongside it. That stylesheet hides everything
     in print except .print-area and .print-visible, so an element carrying
     neither renders as nothing at all. The offscreen copy the PDF is now
     built from had no such class, and every download from that page came out
     empty.

     Asserted on the element itself, because this is the one fault in the
     whole pipeline that produces a perfectly successful-looking failure. */
  {
    await renderRoute("/parties/P1");

    /* The element the PDF is actually built from, by name. Querying for
       ".print-visible" found the on-screen statement instead — which carries
       the class too — so the check passed while the real PDF source had
       none, and the mutation that caused the blank pages survived it. */
    const source = document.querySelector("[data-pdf-source]");
    assert(!!source, "pdf source: the party page has an element PDFs are built from");
    assert(
      source?.classList.contains("print-visible"),
      "pdf source: and it survives the print stylesheet, which hides everything else",
    );

    /* And it is the statement, not an empty wrapper — a blank page passes a
       "does it exist" check just as happily. */
    const text = source?.textContent ?? "";
    assert(
      text.includes("Closing Balance"),
      "pdf source: and it carries the statement, not an empty shell",
    );
    assert(
      text.includes("You Gave") && text.includes("You Got"),
      "pdf source: with the columns the document is supposed to have",
    );
  }

  /* ── A sale line starts at the item's selling price ───────────────────
     The picker showed 7,000 and the line came out at 6,105, because this
     party's own last price beat the catalogue. That preference made sense
     while an item's sale price was rewritten by whatever bill went out last;
     since that write was removed the sale price IS the shop's decision, and
     a different figure arriving on the line is the shop being overruled by
     its own history.

     Asserted because nothing did: all 630 assertions passed both before and
     after the behaviour was reversed, which is the definition of untested. */
  {
    await renderRoute("/sales/new");

    const add = visibleAddItemInput();
    assert(!!add, "sale price: the new-bill form has an item entry row");

    if (add) {
      await act(async () => {
        setInput(add, "USB Cable");
      });
      await settleMs(120);

      /* The option the picker itself marks, not the first div whose text
         happens to start with the name — the outer container matches that
         too, and clicking it does nothing because React events bubble up. */
      const option = Array.from(document.querySelectorAll("[data-opt]")).find((el) =>
        (el.textContent ?? "").includes("USB Cable"),
      );
      assert(!!option, "sale price: the item is offered");
      if (option) {
        await act(async () => {
          option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        });
        await settleMs(160);

        /* USB Cable: cost 60, sells 100. The line must start at 100 — and
           must never start at 60, which is the failure that quietly bills
           at cost. */
        const values = Array.from(document.querySelectorAll("input"))
          .map((el) => (el as HTMLInputElement).value)
          .filter(Boolean);
        assert(
          values.includes("100"),
          "sale price: picking an item creates a line at its price — saw " + values.join(","),
        );
        assert(
          !values.includes("60"),
          "sale price: and never at the purchase price — saw " + values.join(","),
        );
      }
    }
  }

  /* ── The document vault ───────────────────────────────────────────────
     The business's own requirement: somewhere to keep every business
     document, named, and get it back any time.

     What this proves is the half that is checkable without a network — the
     record. The file lives in Firebase Storage and this harness deliberately
     cannot reach it (tests/stubs/firebase.ts hands back no app at all, so an
     upload here would be an upload to the client's live bucket). So: the list
     reads, it says what each document is, and the way out is offered. */
  {
    const page = await renderRoute("/documents");
    has(page, "GST Certificate", "documents: the vault lists what the shop named it");
    has(page, "gst-2026.pdf", "documents: alongside the file's own name");
    has(page, "240 KB", "documents: and its size in something a person reads");
    has(page, "Renewed Sept 2026", "documents: the note is shown");

    const download = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Download"),
    );
    assert(!!download, "documents: every row offers a way to get the file back");

    /* The upload dialog is the only way in, so it has to open. */
    const uploadBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Upload",
    );
    assert(!!uploadBtn, "documents: and there is a way to put one in");
    if (uploadBtn) {
      await act(async () => {
        uploadBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settleMs(160);
      const body = document.body.textContent ?? "";
      assert(body.includes("Upload a document"), "documents: the upload dialog opens");
      assert(
        !!document.querySelector('input[type="file"]'),
        "documents: with a real file picker in it",
      );
      assert(
        body.includes("25 MB"),
        "documents: and says the size limit BEFORE a 40MB scan is chosen",
      );
      const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
      await act(async () => {
        document.dispatchEvent(esc);
      });
      await settleMs(120);
    }
  }

  /* ── The tax a bill actually carries ──────────────────────────────────
     A shop bills inside its own state and outside it in the same week. Until now every
     invoice this app printed split its tax CGST + SGST — including the ones
     to Mumbai, which must carry a single IGST line instead. Same total, two
     different documents, and only one of them is filable.

     The printable is mounted directly rather than through a route, with
     invoices built here. Seeding three more sales into the shared book moved
     every receivable and profit figure the rest of this suite is pinned to —
     a fixture that rewrites ten other tests to prove one thing is a fixture
     that will be deleted the first time it is inconvenient. */
  {
    const gstHost = document.createElement("div");
    document.body.appendChild(gstHost);
    const gstRoot = createRoot(gstHost);

    const company = {
      name: "M DECOR",
      // Registered in Gujarat. The seller's state comes from its own GSTIN,
      // so this one number decides intra against inter for every bill.
      gstin: "24AAACC1234D1ZI",
      currency: "INR",
      invoicePrefix: "INV-",
      purchasePrefix: "PUR-",
      enableGst: true,
    } as never;

    const bill = (over: Record<string, unknown>) =>
      ({
        id: "X",
        number: "INV-X",
        date: "2026-09-10",
        partyId: "PX",
        partyName: "A Customer",
        gstEnabled: true,
        lineItems: [
          {
            id: "L",
            itemId: "I1",
            name: "MS Plate",
            qty: 10,
            unit: "pcs",
            price: 100,
            discountPct: 0,
            gstRate: 18,
            amount: 1180,
          },
        ],
        subtotal: 1000,
        discount: 0,
        taxAmount: 180,
        total: 1180,
        paid: 0,
        paymentMode: "credit",
        ...over,
      }) as never;

    const render = async (inv: never) => {
      await act(async () => {
        gstRoot.render(<PrintableInvoice inv={inv} company={company} mode="sale" />);
      });
      await settleMs(60);
      return gstHost.textContent ?? "";
    };

    /* Gujarat to Gujarat. 18% of 1,000 is 180, and it belongs half to the
       centre and half to the state. */
    const local = await render(
      bill({
        partyName: "Surat Steels",
        partyGstin: "24AAACC1234D1ZI",
        partyState: "Gujarat",
        placeOfSupply: "24",
      }),
    );
    assert(local.includes("CGST"), "gst: a Gujarat bill from a Gujarat shop shows CGST");
    assert(local.includes("SGST"), "gst: and SGST");
    assert(!local.includes("IGST"), "gst: and no IGST");
    assert(local.includes("90.00"), "gst: halved — 90 and 90, not 180 in one column");

    /* Gujarat to Maharashtra. Same total, one column, different government. */
    const far = await render(
      bill({
        partyName: "Mumbai Fabricators",
        partyGstin: "27AAACC1234D1ZC",
        partyState: "Maharashtra",
        placeOfSupply: "27",
      }),
    );
    assert(far.includes("IGST"), "gst: a Maharashtra bill from a Gujarat shop shows IGST");
    assert(!far.includes("CGST"), "gst: and NOT CGST");
    assert(!far.includes("SGST"), "gst: nor SGST");
    assert(far.includes("180.00"), "gst: at the full rate in one column");

    /* A tax invoice that does not say where the supply went cannot be checked
       by anyone reading it. */
    assert(far.includes("Place of Supply"), "gst: the bill says where the supply went");
    assert(far.includes("Maharashtra"), "gst: by name");
    assert(far.includes("27AAACC1234D1ZC"), "gst: and prints the buyer's GSTIN");

    /* The rule that protects a year of history: a bill with no place of
       supply recorded — every bill written before today — keeps printing
       exactly what it printed yesterday. */
    const old = await render(bill({ partyName: "Ramesh Traders" }));
    assert(old.includes("CGST"), "gst: a bill written before any of this still shows CGST");
    assert(!old.includes("IGST"), "gst: and is not silently reclassified as interstate");

    /* ── The particulars Rule 46 requires and this bill did not carry ───
       Checked against the rule rather than against taste: a tax invoice that
       omits any of these is not a valid tax invoice, however good it looks.
       https://taxinformation.cbic.gov.in — CGST Rule 46 */
    {
      const coded = await render(
        bill({
          partyGstin: "27AAACC1234D1ZC",
          placeOfSupply: "27",
          lineItems: [
            {
              id: "L",
              itemId: "I1",
              name: "MS Plate",
              hsn: "7208",
              qty: 10,
              unit: "pcs",
              price: 100,
              discountPct: 0,
              gstRate: 18,
              amount: 1180,
            },
          ],
        }),
      );
      assert(coded.includes("HSN/SAC"), "rule46: the line table carries an HSN/SAC column");
      assert(coded.includes("7208"), "rule46: with the code the line was billed under");
      assert(coded.includes("Reverse Charge"), "rule46: the bill states reverse charge");
      assert(coded.includes("Authorised Signatory"), "rule46: and carries a signature block");

      /* Either way, not silence. A blank is not an answer a return can be
         checked against. */
      assert(/Reverse Charge:\s*No/.test(coded.replace(/\s+/g, " ")), "rule46: No when it is no");
      const rc = await render(bill({ reverseCharge: true }));
      assert(/Reverse Charge:\s*Yes/.test(rc.replace(/\s+/g, " ")), "rule46: and Yes when it is");

      /* A shop that has never filled in an HSN code should not get an empty
         column down every bill it prints. */
      assert(!old.includes("HSN/SAC"), "rule46: no HSN column when no line has a code");
    }

    await act(async () => {
      gstRoot.unmount();
    });
    gstHost.remove();
  }

  /* ── Quotation → proforma → tax invoice ───────────────────────────────
     The sequence the standard prescribes. What is asserted here is mostly
     what these documents must NOT do, because that is where the rules bite:
     neither may move stock, neither may post, and neither may take a number
     from the tax-invoice series — Rule 46 wants that one consecutive. */
  {
    const stockBefore = ItemRepo.get("I1")?.stock ?? 0;
    const invoicesBefore = SalesRepo.all().length;

    /* A quotation, listed. */
    const quotes = await renderRoute("/quotations");
    has(quotes, "QT-0001", "estimates: the quotation is listed under its own number");
    has(quotes, "Mumbai Fabricators", "estimates: against the customer it was sent to");

    /* Nothing it did touched the book. */
    assert(
      (ItemRepo.get("I1")?.stock ?? 0) === stockBefore,
      "estimates: a quotation moves no stock — " + stockBefore + " to " + ItemRepo.get("I1")?.stock,
    );
    assert(SalesRepo.all().length === invoicesBefore, "estimates: and creates no sale");

    /* Convert. A quotation becomes a proforma by COPYING — the customer holds
       a copy of the quotation and it must stay as it was sent. */
    const convert = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Make Proforma"),
    );
    assert(!!convert, "estimates: an open quotation offers to become a proforma");
    if (convert) {
      await act(async () => {
        convert.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settleMs(250);
    }

    const made = EstimateRepo.all().find((e) => e.kind === "proforma");
    assert(!!made, "estimates: a proforma now exists");
    assert(
      made?.number?.startsWith("PI-"),
      "estimates: numbered in the proforma series — " + made?.number,
    );
    /* The rule Rule 46 is actually about: nothing but a tax invoice may draw
       from the tax-invoice series, or that series ends up with a hole. */
    assert(
      !made?.number?.startsWith("INV-"),
      "estimates: and NEVER from the tax-invoice series — " + made?.number,
    );
    assert(made?.fromNumber === "QT-0001", "estimates: the chain reads backwards");

    const quote = EstimateRepo.get("EST-Q1");
    assert(quote?.status === "converted", "estimates: the quotation is marked converted");
    assert(quote?.number === "QT-0001", "estimates: and keeps the number it was sent under");
    assert(
      quote?.convertedToNumber === made?.number,
      "estimates: with a forward link to what it became",
    );

    /* Still nothing in the book. Converting is not selling. */
    assert(
      (ItemRepo.get("I1")?.stock ?? 0) === stockBefore,
      "estimates: converting moves no stock either",
    );
    assert(
      SalesRepo.all().length === invoicesBefore,
      "estimates: and still creates no sale — a tax invoice is raised separately",
    );

    /* The proforma offers the last step, which opens the bill screen rather
       than relabelling itself. */
    const pro = await renderRoute("/proforma");
    has(pro, "PI-", "estimates: the proforma is listed");
    const toInvoice = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Make Invoice"),
    );
    assert(!!toInvoice, "estimates: and offers to raise the tax invoice");

    /* ── The document itself ────────────────────────────────────────────
       A quotation exists to be SENT. The list first offered a Print button
       that called window.print(), which prints the list — so this checks the
       page that actually shows the document. */
    {
      const page = await renderRoute("/quotations/EST-Q1");
      assert(page.includes("QUOTATION"), "estimates: the document is headed QUOTATION");
      assert(
        !page.includes("TAX INVOICE"),
        "estimates: and never as a tax invoice — the heading is what makes it one",
      );
      has(page, "QT-0001", "estimates: showing its own number");
      has(page, "Mumbai Fabricators", "estimates: and the customer");
      assert(page.includes("Valid until"), "estimates: and how long the price is good for");

      const madeProforma = EstimateRepo.all().find((e) => e.kind === "proforma");
      const pPage = await renderRoute(`/proforma/${madeProforma?.id}`);
      assert(pPage.includes("PROFORMA INVOICE"), "estimates: a proforma is headed as one");
      /* The line that stops a customer, or their accountant, treating it as a
         document they can claim credit against. */
      assert(
        /not a tax invoice/i.test(pPage),
        "estimates: and says in as many words that it is not a tax invoice",
      );
      assert(
        /input tax credit/i.test(pPage),
        "estimates: including that no credit may be claimed against it",
      );

      /* It still has to BE a proper GST document otherwise — a proforma is
         supposed to look like the invoice it precedes. */
      assert(pPage.includes("IGST"), "estimates: with the right tax for an out-of-state customer");
      assert(pPage.includes("27AAACC1234D1ZC"), "estimates: and the buyer's GSTIN");
    }
  }

  /* ── The tax-invoice series survives everything built around it ───────
     A quotation screen that quietly burns an invoice number leaves a hole in
     a series Rule 46 requires to be consecutive, and nobody finds it until a
     return is filed. The bill form OPENS holding the next invoice number —
     it is shown in the header before anything is saved — so this is a real
     risk rather than a theoretical one.

     Driven through the actual form, because the arithmetic is only half the
     claim; the other half is what the screen does with it. */
  {
    const nextInvoiceBefore = nextInvoiceNumber("INV-", SalesRepo.all());
    const salesBefore = SalesRepo.all().length;
    const estimatesBefore = EstimateRepo.all().length;

    await renderRoute("/sales/new?doc=quotation");
    await settleMs(200);

    /* The form opened as a quotation, not as a bill. */
    const heading = (host as HTMLElement).textContent ?? "";
    assert(heading.includes("Quotation"), "final: the form opens as a quotation when asked to");

    const partyBox = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[placeholder="Type name or search…"]'),
    ).find((el) => el.offsetParent !== null);
    assert(!!partyBox, "final: the quotation form has a customer box");
    if (partyBox) {
      await act(async () => {
        setInput(partyBox, "Ramesh Traders");
      });
      await settleMs(160);
      const opt = Array.from(document.querySelectorAll<HTMLElement>("div")).find(
        (d) =>
          (d.textContent ?? "").trim() === "Ramesh Traders" &&
          !d.querySelector("div div") &&
          !d.querySelector("input"),
      );
      if (opt) {
        await act(async () => {
          opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        });
        await settleMs(160);
      }
    }

    const add = visibleAddItemInput();
    if (add) {
      await act(async () => {
        setInput(add, "USB Cable");
      });
      await settleMs(160);
      const row = Array.from(document.querySelectorAll<HTMLElement>("[data-opt]")).find((d) =>
        (d.textContent ?? "").startsWith("USB Cable"),
      );
      if (row) {
        await act(async () => {
          row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        });
        await settleMs(200);
      }
    }

    /* GST on, deliberately. A new bill starts with it OFF — the counter turns
       it on per bill — and a quotation follows the same rule, which is right
       but means the GST arithmetic only gets exercised if the test does what
       the shop does. */
    const gstToggle = Array.from(document.querySelectorAll<HTMLElement>("label")).find((l) =>
      (l.textContent ?? "").includes("GST Bill"),
    );
    const gstBox = gstToggle?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    assert(!!gstBox, "final: the quotation form offers the GST toggle");
    if (gstBox && !gstBox.checked) {
      await act(async () => {
        gstBox.click();
      });
      await settleMs(200);
    }

    const saveBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Save",
    );
    assert(!!saveBtn, "final: found Save");
    await act(async () => {
      saveBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settleMs(450);

    /* ── What must have happened ─────────────────────────────────────── */
    assert(
      EstimateRepo.all().length === estimatesBefore + 1,
      "final: the quotation saved — " + EstimateRepo.all().length,
    );
    const saved = EstimateRepo.all().find((e) => e.id !== "EST-Q1" && e.kind === "quotation");
    assert(!!saved, "final: as a quotation");
    assert(
      saved?.number?.startsWith("QT-"),
      "final: numbered in its own series — " + saved?.number,
    );

    /* ── And what must NOT have ──────────────────────────────────────── */
    assert(
      SalesRepo.all().length === salesBefore,
      "final: no sale was created — " + SalesRepo.all().length + " vs " + salesBefore,
    );
    assert(
      nextInvoiceNumber("INV-", SalesRepo.all()) === nextInvoiceBefore,
      `final: the NEXT INVOICE NUMBER is untouched — was ${nextInvoiceBefore}, now ${nextInvoiceNumber("INV-", SalesRepo.all())}`,
    );
    assert(
      !saved?.number?.startsWith("INV-"),
      "final: and the quotation never took a number from the invoice series",
    );

    /* ── The arithmetic is the invoice's arithmetic ───────────────────
       USB Cable sells at 100 at 18% GST. A quotation computes its totals
       through the same recalc the bill does, so if these drift the quotation
       is quoting a price the invoice will not honour. */
    assert(saved?.subtotal === 100, "final: subtotal is the line value — " + saved?.subtotal);
    assert(saved?.taxAmount === 18, "final: GST at 18% is 18 — " + saved?.taxAmount);
    assert(saved?.total === 118, "final: and the total is 118 — " + saved?.total);
    assert(saved?.gstEnabled === true, "final: recorded as a GST quotation");
    assert(
      Math.abs((saved?.subtotal ?? 0) + (saved?.taxAmount ?? 0) - (saved?.total ?? 0)) < 0.005,
      "final: the parts add up to the whole",
    );
  }

  const bulkHost = document.createElement("div");
  document.body.appendChild(bulkHost);
  const bulkRoot = createRoot(bulkHost);
  const startedAt = performance.now();
  await act(async () => {
    bulkRoot.render(<BulkUpdateItemsDialog open onOpenChange={() => {}} onSaved={() => {}} />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 120));
  });
  const mountMs = performance.now() - startedAt;

  // The dialog portals into document.body, so count across the document.
  // The list is no longer paged — the whole catalogue scrolls — but only the
  // rows on screen are mounted (see useWindowedRows). Both the desktop table
  // and the phone card list exist at once (switched by CSS), so a window of
  // ~30 rows each with a name + several fields lands well under this ceiling.
  // Mounting all 1400 would be ~11,000 controls, which is what froze it.
  const inputCount = document.querySelectorAll("input").length;
  assert(
    inputCount > 0 && inputCount < 600,
    `bulk update: only a page of rows may mount — found ${inputCount} inputs for 1400+ items`,
  );
  assert(
    mountMs < 4000,
    `bulk update: opening with 1400 items must not hang — took ${Math.round(mountMs)}ms`,
  );
  // The dialog renders through a portal, so it is NOT inside bulkHost.
  assert(
    (document.body.textContent ?? "").includes("Bulk Update Items"),
    "bulk update: dialog actually rendered",
  );

  // The dialog's close button is absolutely positioned in the corner, so the
  // header content must not run underneath it — the tab group did, leaving
  // the X sitting on top of "Item Information".
  {
    const closeBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Close",
    );
    // Target THIS dialog's tab group by its label — other radiogroups
    // (payment ModePills) can still be in the document from earlier mounts.
    const tabs = document.querySelector('[role="radiogroup"][aria-label="What to update"]');
    assert(!!closeBtn, "bulk update: found the close button");
    assert(!!tabs, "bulk update: found the mode tabs");
    if (closeBtn && tabs) {
      const c = closeBtn.getBoundingClientRect();
      const t = tabs.getBoundingClientRect();
      const overlaps = t.right > c.left && t.left < c.right && t.bottom > c.top && t.top < c.bottom;
      assert(
        !overlaps,
        `bulk update: tabs must not sit under the close button — tabs ${Math.round(t.left)}..${Math.round(t.right)} x ${Math.round(t.top)}..${Math.round(t.bottom)}; X ${Math.round(c.left)}..${Math.round(c.right)} x ${Math.round(c.top)}..${Math.round(c.bottom)}; vw=${window.innerWidth}`,
      );
    }
  }

  bulkRoot.unmount();
  bulkHost.remove();

  if (root) root.unmount();
  if (host) host.remove();
  return R;
}
