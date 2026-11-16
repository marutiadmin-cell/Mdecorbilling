/**
 * Monkey test — the WHOLE app, driven the way a person drives it.
 *
 *   npm run test:monkey                (40 random steps, random seed)
 *   MONKEY_SEED=1234 MONKEY_STEPS=80 npm run test:monkey
 *
 * The seed is printed first, so a failing run replays exactly.
 *
 * Why this exists next to screens.test.tsx: those tests reach controls with
 * el.click() and synthetic events, which skip the browser's hit-testing — a
 * button that is covered, off screen or under pointer-events:none still
 * "works" there. Every click and keystroke here is a REAL one, sent through
 * Chrome's input pipeline by the runner (window.__realMouse / __realType), so
 * "I click and nothing happens" is a failure here.
 *
 * The data is shaped like a shop's, not a fixture's: numbers stored as text,
 * items with no unit or price, a Gujarati name, stock already below zero.
 * Random steps add, edit and delete items, parties, sales, purchases,
 * payments, expenses, BOMs and production runs — and after EVERY step the
 * whole book is checked:
 *   - Settings → Fix calculations has nothing to fix (stock, bank, bills),
 *   - every document's postings balance and the balance sheet difference is 0,
 *   - each party's balance agrees between the ledger and the postings,
 *   - no bill is paid more than its total, or below zero,
 *   - and each step's own result is what was typed.
 */
import { createRoot, type Root } from "react-dom/client";
import { pieceDataFromRepos } from "@/lib/pieceData";
import { type ReactNode } from "react";
import { createRouter, createMemoryHistory, RouterProvider, Outlet } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "@/routeTree.gen";
import { seedDemoShop } from "./demoShop";
import { bookProblems } from "./books";
import { bagsOf } from "@/lib/pieces";
import { Toaster } from "@/components/ui/sonner";
import { planDataRepair } from "@/lib/dataRepair";
import { consumptionFor } from "@/lib/production";
import { consumptionForSize } from "@/lib/sizing";
import { buildPostings, unbalancedDocs, balances, rupees, ACC } from "@/lib/postings";
import { buildFinancials } from "@/lib/financials";
import { booksData, finInputFromRepos } from "@/lib/finData";
import { netPartyPositions } from "@/lib/ledger";
import { ymd } from "@/lib/format";
import {
  ItemRepo,
  PartyRepo,
  CompanyRepo,
  BomRepo,
  ProductionRepo,
  PurchaseRepo,
  SalesRepo,
  PaymentRepo,
  ExpenseRepo,
  BankRepo,
  BankTxnRepo,
  SaleReturnRepo,
  PurchaseReturnRepo,
  PieceSortRepo,
  JournalVoucherRepo,
} from "@/repositories";
import type { Invoice, Item, Party } from "@/types";

export interface Results {
  passed: number;
  failed: number;
  fails: string[];
}
const R: Results = { passed: 0, failed: 0, fails: [] };
let stepLabel = "setup";
const notes: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) R.passed++;
  else {
    R.failed++;
    if (R.fails.length < 80) R.fails.push(`[${stepLabel}] ${msg}`);
  }
}

declare global {
  interface Window {
    __realMouse: (x: number, y: number, kind?: string) => Promise<void>;
    __realType: (text: string) => Promise<void>;
    __realKey: (key: string, mod?: string) => Promise<void>;
  }
}

/* ── seeded randomness, so a failure can be replayed ───────────────────── */
const G = globalThis as { __MONKEY_SEED__?: number; __MONKEY_STEPS__?: number };
const SEED = Number(G.__MONKEY_SEED__ ?? Date.now() % 100000);
let rs = SEED >>> 0;
function rand() {
  rs = (rs + 0x6d2b79f5) >>> 0;
  let t = rs;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(a: T[]): T => a[Math.floor(rand() * a.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const close = (a: number, b: number) => Math.abs(a - b) < 0.011;
const r2 = (n: number) => Math.round(n * 100) / 100;

/* ── real input ────────────────────────────────────────────────────────── */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Click an element where a person would: its centre, after scrolling it
 *  into view. Fails (and says what is in the way) if something covers it.
 *  A toast sitting on top is waited out first, as a person would. */
async function click(el: Element | null | undefined, what: string): Promise<boolean> {
  if (!el) {
    assert(false, `${what}: not on screen`);
    return false;
  }
  let x = 0,
    y = 0,
    hit: Element | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    (el as HTMLElement).scrollIntoView({ block: "center", inline: "center" });
    await wait(40);
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) {
      assert(false, `${what}: has no size, cannot be clicked`);
      return false;
    }
    x = Math.round(r.left + r.width / 2);
    y = Math.round(r.top + r.height / 2);
    hit = document.elementFromPoint(x, y);
    const isToast = !!hit?.closest("[data-sonner-toast]");
    if (isToast && attempt === 0) {
      notes.push(`a toast covered "${what}" — waited for it to go`);
      await wait(4200);
      continue;
    }
    break;
  }
  const reachable = !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  assert(
    reachable,
    hit
      ? `${what}: a click there lands on <${hit.tagName.toLowerCase()} class="${String(
          (hit as HTMLElement).className ?? "",
        ).slice(0, 50)}"> instead`
      : `${what}: its centre (${x}, ${y}) is off the screen (${window.innerWidth}×${window.innerHeight}) even after scrolling to it`,
  );
  console.info(`[monkey] ${stepLabel} › ${what}`);
  await window.__realMouse(x, y);
  await wait(150);
  return reachable;
}

/** Click a box, select what is in it, and type over it. */
async function typeInto(el: Element | null | undefined, text: string, what: string) {
  if (!(await click(el, what))) return false;
  await window.__realKey("a", "Control");
  await window.__realKey("Backspace");
  if (text) await window.__realType(text);
  await wait(180);
  return true;
}

function dialog(): HTMLElement | null {
  const all = document.querySelectorAll('[role="dialog"]');
  return (all[all.length - 1] as HTMLElement) ?? null;
}
function dialogTitled(re: RegExp): HTMLElement | null {
  return (
    (Array.from(document.querySelectorAll('[role="dialog"]')).find((d) =>
      re.test(d.querySelector("h2")?.textContent ?? ""),
    ) as HTMLElement | undefined) ?? null
  );
}
function button(scope: ParentNode | null, re: RegExp): HTMLButtonElement | undefined {
  return Array.from(scope?.querySelectorAll("button") ?? []).find(
    (b) => re.test((b.textContent ?? "").trim()) && (b as HTMLElement).offsetParent !== null,
  ) as HTMLButtonElement | undefined;
}
/** The input inside a <label> whose caption is exactly `caption`. */
function field(scope: ParentNode | null, caption: string): HTMLInputElement | null {
  const lab = Array.from(scope?.querySelectorAll("label") ?? []).find(
    (l) => (l.querySelector("span")?.textContent ?? "").trim() === caption,
  );
  return (lab?.querySelector("input") as HTMLInputElement | null) ?? null;
}
function visible<T extends Element>(sel: string): T | null {
  return (
    (Array.from(document.querySelectorAll<T>(sel)).find(
      (e) => (e as unknown as HTMLElement).offsetParent !== null,
    ) as T | undefined) ?? null
  );
}
function rowWith(text: string): HTMLElement | undefined {
  const tr = Array.from(document.querySelectorAll("tr")).find(
    (r) => (r.textContent ?? "").includes(text) && (r as HTMLElement).offsetParent !== null,
  ) as HTMLElement | undefined;
  if (tr) return tr;
  // Phone: the list is cards. Walk up from each visible action button to the
  // smallest block that names this record and holds only one set of actions.
  for (const b of Array.from(document.querySelectorAll<HTMLElement>("button[title]"))) {
    if (b.offsetParent === null) continue;
    let el: HTMLElement | null = b.parentElement;
    for (let i = 0; el && i < 8; i++, el = el.parentElement) {
      if (!(el.textContent ?? "").includes(text)) continue;
      const titles = Array.from(el.querySelectorAll("button[title]")).map((x) =>
        x.getAttribute("title"),
      );
      if (new Set(titles).size === titles.length) return el;
      break;
    }
  }
  return undefined;
}

/* Toasts are React's nodes — never touch them. An observer notes each one
   as it appears; a step reads only those since its own clearToasts(). */
let seenToasts: string[] = [];
const toastObserver = new MutationObserver((muts) => {
  for (const m of muts)
    m.addedNodes.forEach((n) => {
      if (!(n instanceof HTMLElement)) return;
      const t = n.matches("[data-sonner-toast]")
        ? [n]
        : Array.from(n.querySelectorAll("[data-sonner-toast]"));
      for (const el of t)
        setTimeout(
          () =>
            seenToasts.push(
              `${el.getAttribute("data-type") ?? ""}: ${(el.textContent ?? "").trim()}`,
            ),
          30,
        );
    });
});
const toasts = () => seenToasts;
async function clearToasts() {
  await wait(20);
  seenToasts = [];
}

/** Choose an item in an ItemPicker (BOM / production) by typing its name. */
async function pickItem(input: Element | null | undefined, item: Item, what: string) {
  const typed = item.name.slice(0, Math.max(3, Math.ceil(item.name.length * rand())));
  if (!(await typeInto(input, typed, what))) return false;
  const opt = Array.from(document.querySelectorAll('[role="listbox"] [role="option"]')).find(
    (o) => (o.querySelector("span")?.textContent ?? "").trim() === item.name,
  );
  if (!opt) {
    assert(false, `${what}: typing "${typed}" does not list "${item.name}"`);
    await window.__realKey("Escape");
    return false;
  }
  return click(opt, `${what}: option "${item.name}"`);
}

/** Choose from the bill form's own dropdowns (party, item): [data-opt] rows
 *  whose bold first line is the name. */
async function pickOpt(name: string, what: string) {
  await wait(120);
  const opt = Array.from(document.querySelectorAll("[data-opt]")).find(
    (o) =>
      (o.querySelector(".font-semibold")?.textContent ?? "").trim() === name &&
      (o as HTMLElement).offsetParent !== null,
  );
  if (!opt) {
    assert(false, `${what}: "${name}" is not offered`);
    return false;
  }
  return click(opt, `${what}: "${name}"`);
}

/* ── mounting ──────────────────────────────────────────────────────────── */
let root: Root | null = null;
let host: HTMLDivElement | null = null;
async function go(path: string) {
  // Leave nothing open from the step before.
  for (let i = 0; i < 3 && dialog(); i++) {
    await window.__realKey("Escape");
    await wait(120);
  }
  const router = createRouter({
    routeTree,
    context: { queryClient: new QueryClient() },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  if (root) root.unmount();
  if (host) host.remove();
  document
    .querySelectorAll('[role="dialog"]')
    .forEach((d) => d.closest("[data-radix-portal]")?.remove());
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<RouterProvider router={router} />);
  await wait(300);
}

/* ── the shop ──────────────────────────────────────────────────────────── */
const ITEMS: Array<Partial<Item> & { id: string; name: string }> = [
  {
    id: "RAW-VEL",
    name: "Velvet Fabric Royal Blue",
    unit: "mtr",
    kind: "raw",
    stock: 120,
    purchasePrice: 300,
    salePrice: 450,
  },
  // Numbers that arrived as TEXT — older records and imports do this.
  {
    id: "RAW-FOAM",
    name: 'Foam Sheet 4" HD',
    unit: "pcs",
    kind: "raw",
    stock: "40" as never,
    purchasePrice: "900" as never,
    salePrice: 1200,
  },
  {
    id: "RAW-WOOD",
    name: "Wooden Frame Set",
    unit: "set",
    kind: "raw",
    stock: 15,
    purchasePrice: 2200,
  },
  // No unit, no price, no type at all.
  { id: "RAW-GLUE", name: "Fevicol SH 1kg", stock: 30 } as never,
  {
    id: "FG-SOFA3",
    name: "Sofa 3 Seater Royal",
    unit: "pcs",
    kind: "finished",
    stock: 0,
    salePrice: 32000,
  },
  {
    id: "FG-SOFA2",
    name: "Sofa 2 Seater",
    unit: "pcs",
    kind: "finished",
    stock: 2,
    salePrice: 22000,
  },
  {
    id: "RAW-SLAT",
    name: "Slat 50mm Wooden",
    unit: "pcs",
    kind: "raw",
    stock: 600,
    purchasePrice: 54,
    salePrice: 80,
  },
  { id: "RAW-RAIL", name: "Head Rail", unit: "ft", kind: "raw", stock: 80.5, purchasePrice: 112 },
  { id: "RAW-LADR", name: "Ladder Tape", unit: "mtr", kind: "raw", stock: 300, purchasePrice: 30 },
  {
    id: "RAW-MECH",
    name: "Mechanism Easy Lift",
    unit: "pcs",
    kind: "raw",
    stock: 20,
    purchasePrice: 218,
  },
  // Gujarati name, and stock already below zero.
  {
    id: "RAW-CHAIN",
    name: "ચેઇન Chain Metal",
    unit: "pcs",
    kind: "raw",
    stock: -3,
    purchasePrice: 50,
    salePrice: 90,
  },
  {
    id: "FG-BLIND",
    name: "Wooden Blind Easy Lift",
    unit: "pcs",
    kind: "finished",
    stock: 0,
    salePrice: 6500,
  },
  {
    id: "TR-CUSH",
    name: "Cushion Cover",
    unit: "pcs",
    stock: 50,
    purchasePrice: 120,
    salePrice: 250,
  },
];
const FINISHED = ["FG-SOFA3", "FG-SOFA2", "FG-BLIND"];
const RAWS = ITEMS.filter((i) => !FINISHED.includes(i.id) && i.id !== "TR-CUSH").map((i) => i.id);

/** MONKEY_DATA=big: start from a whole dummy shop (tests/demoShop.ts) — every
 *  action then works among hundreds of existing records. */
const BIG = (globalThis as { __MONKEY_DATA__?: string }).__MONKEY_DATA__ === "big";

function seed() {
  if (BIG) seedDemoShop({ scale: 1, seed: SEED });
  if (!BIG)
    CompanyRepo.save({
      name: "M DECOR",
      gstin: "24AAACC1234D1ZI",
      currency: "INR",
      invoicePrefix: "INV-",
      purchasePrefix: "PUR-",
      enableGst: false,
      allowNegativeStock: true,
      expenseCategories: ["Rent", "Karigar wages", "Transport"],
    } as never);
  for (const it of ITEMS) {
    // The app refuses duplicate item names; the big shop already has some.
    if (BIG && ItemRepo.all().some((x) => x.name === it.name)) continue;
    ItemRepo.add({
      gstRate: 0,
      salePrice: 0,
      openingStock: it.stock,
      createdAt: "2026-01-01T00:00:00Z",
      ...it,
    } as never);
  }
  for (const p of [
    { id: "C-KUNT", name: "Kunteshwar Furniture", type: "customer", phone: "9558945607" },
    { id: "C-RAJ", name: "Rajesh Interiors", type: "customer", openingBalance: 5000 },
    { id: "C-WALK", name: "Walk-in Customer", type: "customer" },
    { id: "S-FAB", name: "Shree Fabrics Surat", type: "supplier", openingBalance: -12000 },
    { id: "S-BLND", name: "Blinds Hardware Co", type: "supplier" },
    { id: "B-BOTH", name: "Patel Traders", type: "both" },
  ])
    PartyRepo.add({ openingBalance: 0, createdAt: "2026-01-01T00:00:00Z", ...p } as never);
  // The big shop already has "HDFC Current" under the same id.
  if (!BIG)
    BankRepo.add({
      id: "BANK-HDFC",
      name: "HDFC Current",
      openingBalance: 50000,
      balance: 50000,
      createdAt: "2026-01-01T00:00:00Z",
    } as never);
}
const customers = () => PartyRepo.all().filter((p) => !p.archived && p.type !== "supplier");
const suppliers = () => PartyRepo.all().filter((p) => !p.archived && p.type !== "customer");
const tradable = () => ItemRepo.all().filter((i) => !i.name.startsWith("ચે") || rand() < 0.5);

/* ── the whole book, checked after every step ──────────────────────────── */
const today = ymd(new Date());
const fyStart = (() => {
  const d = new Date();
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-04-01`;
})();

function checkBooks() {
  // The same whole-book checks the full-shop test runs (tests/books.ts).
  const problems = bookProblems();
  assert(problems.length === 0, problems.slice(0, 4).join(" | "));
}

/* ── actions: items & parties ──────────────────────────────────────────── */
let serial = 0;

async function createItem() {
  await go("/items");
  if (!(await click(button(document, /New Item/), "New Item"))) return;
  const dlg = dialogTitled(/New Item/);
  const name = `Monkey Item ${++serial}`;
  const sale = pick([99, 250, 1499.5, 6500]);
  const buy = r2(sale * pick([0.5, 0.7]));
  const open = pick([0, 5, 12.5, 100]);
  await typeInto(field(dlg, "Name *") ?? dlg?.querySelector("input"), name, "item name");
  await typeInto(field(dlg, "Sale Price *"), String(sale), "sale price");
  await typeInto(field(dlg, "Last Purchase Price"), String(buy), "purchase price");
  await typeInto(field(dlg, "Opening Stock"), String(open), "opening stock");
  await clearToasts();
  await click(button(dlg, /^Save$/), "Save item");
  await wait(250);
  const it = ItemRepo.all().find((i) => i.name === name);
  assert(!!it, `item not created — toasts ${JSON.stringify(toasts())}`);
  if (!it) return;
  assert(close(num(it.salePrice), sale), `sale price ${it.salePrice}, typed ${sale}`);
  assert(close(num(it.purchasePrice), buy), `purchase price ${it.purchasePrice}, typed ${buy}`);
  assert(close(num(it.stock), open), `stock ${it.stock}, opening typed ${open}`);
}

async function editItem() {
  const it = pick(ItemRepo.all());
  await go("/items");
  const row = rowWith(it.name);
  if (!row)
    return notes.push(`item "${it.name}" not on the first page of /items`) as unknown as void;
  if (!(await click(row.querySelector('button[title="Edit item"]'), `edit item "${it.name}"`)))
    return;
  const dlg = dialogTitled(/Edit Item/);
  const sale = pick([111, 275, 999]);
  const stockBefore = num(ItemRepo.get(it.id)?.stock);
  await typeInto(field(dlg, "Sale Price *"), String(sale), "sale price (edit)");
  await clearToasts();
  await click(button(dlg, /^Save$/), "Save item (edit)");
  await wait(250);
  const after = ItemRepo.get(it.id);
  assert(close(num(after?.salePrice), sale), `edit: sale price ${after?.salePrice}, typed ${sale}`);
  assert(
    close(num(after?.stock), stockBefore),
    `edit: stock moved ${stockBefore} → ${after?.stock}`,
  );
}

async function deleteItem() {
  const it = pick(ItemRepo.all());
  await go("/items");
  const row = rowWith(it.name);
  if (!row) return;
  await clearToasts();
  await click(row.querySelector('button[title="Delete item"]'), `delete item "${it.name}"`);
  await wait(250);
  const used =
    [...SalesRepo.all(), ...PurchaseRepo.all()].some((d) =>
      d.lineItems.some((l) => l.itemId === it.id),
    ) ||
    BomRepo.all().some(
      (b) => b.finishedItemId === it.id || b.components.some((c) => c.itemId === it.id),
    ) ||
    ProductionRepo.all().some(
      (p) => p.finishedItemId === it.id || p.components.some((c) => c.itemId === it.id),
    );
  if (used) assert(!!ItemRepo.get(it.id), `an item in use was deleted: ${it.name}`);
  else notes.push(`delete item "${it.name}": ${ItemRepo.get(it.id) ? "kept" : "deleted"}`);
}

async function createParty() {
  await go("/parties");
  if (!(await click(button(document, /New Party/), "New Party"))) return;
  const dlg = dialogTitled(/New Party/);
  const name = `Monkey Party ${++serial}`;
  const phone = `98${between(10000000, 99999999)}`;
  await typeInto(field(dlg, "Name *") ?? dlg?.querySelector("input"), name, "party name");
  await typeInto(field(dlg, "Phone"), phone, "party phone");
  const ob = pick([0, 0, 2500]);
  if (ob)
    await typeInto(
      dlg?.querySelector('input[aria-label="Opening balance amount"]'),
      String(ob),
      "opening balance",
    );
  await clearToasts();
  await click(button(dlg, /^Save$/), "Save party");
  await wait(250);
  const p = PartyRepo.all().find((x) => x.name === name);
  assert(!!p, `party not created — toasts ${JSON.stringify(toasts())}`);
  if (p) {
    assert(p.phone === phone, `phone ${p.phone}, typed ${phone}`);
    assert(close(Math.abs(num(p.openingBalance)), ob), `opening ${p.openingBalance}, typed ${ob}`);
  }
}

/* ── actions: bills ────────────────────────────────────────────────────── */
async function createBill(kind: "sale" | "purchase") {
  const repo = kind === "sale" ? SalesRepo : PurchaseRepo;
  await go(kind === "sale" ? "/sales/new" : "/purchase/new");
  const before = repo.all().length;
  const knownIds = new Set(repo.all().map((d) => d.id));
  const stockBefore = new Map(ItemRepo.all().map((i) => [i.id, num(i.stock)] as const));

  // Party: an existing one, or now and then a brand-new name.
  const newParty = rand() < 0.15 ? `Counter Party ${++serial}` : null;
  const party: Party | undefined = newParty
    ? undefined
    : pick(kind === "sale" ? customers() : suppliers());
  const partyBox = visible<HTMLInputElement>('input[placeholder="Type name or search…"]');
  await typeInto(partyBox, newParty ?? party!.name.slice(0, 6), "party");
  if (party) {
    if (!(await pickOpt(party.name, "party"))) return;
  } else await window.__realKey("Tab");

  // 1–3 lines.
  const lines: Array<{ item: Item; qty: number }> = [];
  const pool = [...tradable()].sort(() => rand() - 0.5).slice(0, between(1, 3));
  for (const item of pool) {
    const addBox = visible<HTMLInputElement>('input[placeholder="Type item name to add…"]');
    await typeInto(
      addBox,
      item.name.slice(0, Math.max(4, Math.ceil(item.name.length * 0.6))),
      "item",
    );
    if (!(await pickOpt(item.name, "item"))) {
      await window.__realKey("Escape");
      continue;
    }
    await wait(150);
    // The qty box takes focus on its own after an item is added.
    const qty = pick([1, 2, 3, 0.5, 10]);
    const active = document.activeElement as HTMLInputElement | null;
    if (!active?.id?.startsWith("qty-")) {
      assert(
        false,
        `after adding "${item.name}" the cursor is not in its quantity box (it is in ${active?.tagName}#${active?.id})`,
      );
      continue;
    }
    await window.__realKey("a", "Control");
    await window.__realType(String(qty));
    await wait(120);
    lines.push({ item, qty });
  }
  if (!lines.length) return;

  // How it was paid.
  const mode = pick(["cash", "bank", "credit", "cash"] as const);
  const modeBtn = visible<HTMLElement>(`[data-mode="${mode}"]`);
  await click(modeBtn, `mode ${mode}`);
  let partPaid: number | null = null;
  if (mode === "bank") {
    const bankBox = visible<HTMLInputElement>('input[placeholder="Search bank account…"]');
    await typeInto(bankBox, "HDFC", "bank account");
    const opt = Array.from(document.querySelectorAll("div,button")).find(
      (d) =>
        (d.textContent ?? "").trim().startsWith("HDFC Current") &&
        d.children.length <= 2 &&
        (d as HTMLElement).offsetParent !== null,
    );
    await click(opt, "bank option HDFC");
  }
  if (mode !== "credit") {
    if (rand() < 0.6) {
      await click(
        visible<HTMLElement>(
          kind === "sale"
            ? 'button[title="Received full amount"]'
            : 'button[title="Paid full amount"]',
        ) ?? button(document, /^Full$/),
        "Full",
      );
    } else {
      partPaid = pick([100, 500]);
      await typeInto(
        visible<HTMLInputElement>(
          `input[aria-label="${kind === "sale" ? "Received amount" : "Paid amount"}"]`,
        ),
        String(partPaid),
        "amount paid",
      );
    }
  }
  await clearToasts();
  await click(button(document, /^Save$/), "Save bill");
  await wait(350);
  // A brand-new name opens the Parties page's own form first.
  if (newParty) {
    const pd = dialogTitled(/New Party/);
    assert(!!pd, "a new party name on a bill opens the full party form");
    if (pd) {
      await click(button(pd, /^Save$/), "Save new party (from bill)");
      await wait(450);
    }
  }
  const made = repo.all().filter((d) => !knownIds.has(d.id));
  assert(
    repo.all().length === before + 1 && made.length === 1,
    `${kind} not saved — toasts ${JSON.stringify(toasts())}`,
  );
  const inv: Invoice | undefined = made[0];
  if (!inv) return;
  // What was typed is what was saved.
  for (const l of lines) {
    const saved = inv.lineItems.find((x) => x.itemId === l.item.id);
    assert(
      !!saved && close(num(saved.qty), l.qty),
      `${inv.number}: ${l.item.name} qty ${saved?.qty}, typed ${l.qty}`,
    );
    const sign = kind === "sale" ? -1 : 1;
    assert(
      close(num(ItemRepo.get(l.item.id)?.stock), (stockBefore.get(l.item.id) ?? 0) + sign * l.qty),
      `${inv.number}: stock of ${l.item.name} ${stockBefore.get(l.item.id)} → ${ItemRepo.get(l.item.id)?.stock}, expected ${sign * l.qty}`,
    );
  }
  if (newParty)
    assert(inv.partyName === newParty, `${inv.number}: party ${inv.partyName}, typed ${newParty}`);
  else
    assert(
      inv.partyId === party!.id,
      `${inv.number}: party ${inv.partyName}, picked ${party!.name}`,
    );
  if (mode === "credit") assert(num(inv.paid) === 0, `${inv.number}: credit but paid ${inv.paid}`);
  else if (partPaid !== null)
    assert(
      close(num(inv.paid), Math.min(partPaid, num(inv.total))),
      `${inv.number}: paid ${inv.paid}, typed ${partPaid}`,
    );
  else
    assert(
      close(num(inv.paid), num(inv.total)),
      `${inv.number}: "Full" but paid ${inv.paid} of ${inv.total}`,
    );
  if (mode === "bank" && num(inv.paid) > 0)
    assert(inv.bankId === "BANK-HDFC", `${inv.number}: bank ${inv.bankId}`);
}

async function editBill(kind: "sale" | "purchase") {
  const repo = kind === "sale" ? SalesRepo : PurchaseRepo;
  const inv = pick(repo.all());
  if (!inv) return createBill(kind);
  await go(kind === "sale" ? `/sales/edit/${inv.id}` : `/purchase/edit/${inv.id}`);
  const line = inv.lineItems[0];
  const box = [
    document.getElementById(`qty-${line.id}`),
    document.getElementById(`qty-m-${line.id}`),
  ].find((b) => b && (b as HTMLElement).offsetParent !== null);
  if (!box || (box as HTMLElement).offsetParent === null) {
    assert(false, `${inv.number}: the edit form shows no quantity box for ${line.name}`);
    return;
  }
  const stockBefore = num(ItemRepo.get(line.itemId)?.stock);
  const newQty = pick([1, 4, 7]);
  await typeInto(box, String(newQty), "qty (edit)");
  await clearToasts();
  await click(button(document, /^Save$/), "Save bill (edit)");
  await wait(400);
  const after = repo.get(inv.id);
  const l2 = after?.lineItems.find((l) => l.id === line.id);
  // A split-paid bill cut below what was paid is REFUSED on purpose — only
  // the shop knows which part (cash or bank) to reduce. That is correct.
  if (toasts().some((t) => /split rows add up to/.test(t))) {
    notes.push(
      `${inv.number}: lowering a split-paid bill below its payment was refused, as it should be`,
    );
    return;
  }
  assert(
    close(num(l2?.qty), newQty),
    `${inv.number}: qty ${l2?.qty}, typed ${newQty} — toasts ${JSON.stringify(toasts())}`,
  );
  const sign = kind === "sale" ? -1 : 1;
  const sameItemOtherLines = inv.lineItems.filter(
    (l) => l.id !== line.id && l.itemId === line.itemId,
  ).length;
  if (!sameItemOtherLines && ItemRepo.get(line.itemId))
    assert(
      close(num(ItemRepo.get(line.itemId)?.stock), stockBefore + sign * (newQty - num(line.qty))),
      `${inv.number}: editing ${line.name} ${line.qty}→${newQty} moved stock ${stockBefore}→${ItemRepo.get(line.itemId)?.stock}`,
    );
}

async function deleteBill(kind: "sale" | "purchase") {
  const repo = kind === "sale" ? SalesRepo : PurchaseRepo;
  const inv = pick(repo.all());
  if (!inv) return;
  await go(kind === "sale" ? "/sales" : "/purchase");
  const row = rowWith(inv.number);
  if (!row) return notes.push(`${inv.number} not on the first page of the list`) as unknown as void;
  await clearToasts();
  await click(
    row.querySelector(`button[title="${kind === "sale" ? "Delete invoice" : "Delete bill"}"]`),
    `delete ${inv.number}`,
  );
  await wait(400);
  if (repo.get(inv.id)) notes.push(`${inv.number} was not deleted: ${JSON.stringify(toasts())}`);
}

/* ── actions: payments & expenses ──────────────────────────────────────── */
async function createPayment(dir: "in" | "out") {
  await go("/payments");
  const before = PaymentRepo.all().length;
  const beforeIds = new Set(PaymentRepo.all().map((x) => x.id));
  if (
    !(await click(
      button(document, dir === "in" ? /Receive Payment/ : /Make Payment/),
      dir === "in" ? "Receive Payment" : "Make Payment",
    ))
  )
    return;
  const dlg = dialog();
  const party = pick(dir === "in" ? customers() : suppliers());
  const box = dlg?.querySelector('input[placeholder="Type to search party…"]');
  // Enough of the name to find it among many similar ones, as a person would.
  await typeInto(box, party.name, "payment party");
  const opt = Array.from(document.querySelectorAll("div"))
    .filter((d) => d.textContent === party.name)
    .pop();
  if (!(await click(opt, `payment party "${party.name}"`))) return;
  const amount = pick([200, 750, 1000]);
  const amountBox = dialog()?.querySelector(
    `input[aria-label="${dir === "in" ? "Amount received" : "Amount paid"}"]`,
  );
  // Every value the box passes through while typing — a lost keystroke shows
  // up as the value stepping BACK, and this says exactly when.
  const trail: string[] = [];
  const amtEl = amountBox as HTMLInputElement | null;
  const onInput = () => trail.push(`input:"${amtEl?.value}"`);
  amtEl?.addEventListener("input", onInput);
  await typeInto(amountBox, String(amount), "payment amount");
  amtEl?.removeEventListener("input", onInput);
  const shown = amtEl?.value;
  if (shown !== String(amount))
    assert(false, `payment amount box: typed ${amount}, it shows ${shown} — ${trail.join(" ")}`);
  await click(dialog()?.querySelector('[data-mode="cash"]'), "payment mode cash");
  await clearToasts();
  await click(button(dialog(), dir === "in" ? /Confirm Receipt/ : /Confirm Payment/), "Confirm");
  await wait(350);
  const ok = PaymentRepo.all().length === before + 1;
  if (!ok && toasts().some((t) => /set against|raise the amount/.test(t))) {
    notes.push(`payment of ${amount} refused (bills auto-applied exceed it): ${toasts()[0]}`);
    return;
  }
  assert(ok, `payment not saved — toasts ${JSON.stringify(toasts())}`);
  const p = PaymentRepo.all().find((x) => x.partyId === party.id && x.amount === amount);
  if (!p) {
    const newest = PaymentRepo.all().find((x) => !beforeIds.has(x.id));
    assert(
      false,
      `payment: typed ${amount} for ${party.name}; saved ${JSON.stringify(newest && { party: newest.partyName, amount: newest.amount, alloc: newest.allocations, mode: newest.mode })} — box showed ${shown}`,
    );
  }
}

async function deletePayment() {
  const p = pick(PaymentRepo.all());
  if (!p) return;
  await go("/payments");
  // The visible one — a phone shows cards, the table is there but hidden.
  const row = rowWith(p.partyName);
  if (!row) return;
  await click(
    row.querySelector('button[title="Delete payment"]'),
    `delete payment (${p.partyName})`,
  );
  await wait(300);
}

async function createExpense() {
  await go("/expenses");
  const before = ExpenseRepo.all().length;
  if (!(await click(button(document, /New Expense/), "New Expense"))) return;
  const dlg = dialog();
  await click(dlg?.querySelector('[role="combobox"]'), "expense category");
  const cat = pick(["Rent", "Karigar wages", "Transport"]);
  const opt = Array.from(document.querySelectorAll('[role="option"]')).find(
    (o) => (o.textContent ?? "").trim() === cat,
  );
  await click(opt, `category ${cat}`);
  await typeInto(
    dialog()?.querySelector('input[placeholder="Employee, landlord, vendor…"]'),
    pick(["Ramesh karigar", "Landlord", "Tempo"]),
    "paid to",
  );
  await window.__realKey("Tab");
  await wait(250); // the suggestions close a moment after leaving the box
  const amount = pick([350, 1200, 5000]);
  await typeInto(field(dialog(), "Amount *"), String(amount), "expense amount");
  await click(dialog()?.querySelector('[data-mode="cash"]'), "expense mode cash");
  await clearToasts();
  await click(button(dialog(), /^Save$/), "Save expense");
  await wait(300);
  assert(
    ExpenseRepo.all().length === before + 1,
    `expense not saved — toasts ${JSON.stringify(toasts())}`,
  );
}

async function deleteExpense() {
  const e = pick(ExpenseRepo.all());
  if (!e) return;
  await go("/expenses");
  const btn = Array.from(document.querySelectorAll('button[title="Delete expense"]')).find(
    (b) => (b as HTMLElement).offsetParent !== null,
  );
  if (!btn) return;
  const before = ExpenseRepo.all().length;
  await click(btn, "delete expense");
  await wait(300);
  assert(ExpenseRepo.all().length === before - 1, "expense not deleted");
}

/* ── actions: BOM & production ─────────────────────────────────────────── */
async function createBom() {
  await go("/boms");
  const before = BomRepo.all().length;
  if (!(await click(button(document, /New BOM/), "New BOM button"))) return;
  const dlg = dialog();
  const finished = ItemRepo.get(pick(FINISHED));
  if (!finished) return;
  if (
    !(await pickItem(
      dlg?.querySelector('input[aria-label="Finished item"]'),
      finished,
      "finished item",
    ))
  )
    return;
  const mats = [...RAWS]
    .filter((id) => ItemRepo.get(id))
    .sort(() => rand() - 0.5)
    .slice(0, between(1, 4));
  const typedQty = new Map<string, number>();
  for (let i = 0; i < mats.length; i++) {
    let rows = dlg?.querySelectorAll('input[aria-label="Material"]') ?? [];
    if (rows.length <= i) {
      await click(button(dlg, /Add material/), "Add material");
      rows = dlg?.querySelectorAll('input[aria-label="Material"]') ?? [];
    }
    const it = ItemRepo.get(mats[i])!;
    if (!(await pickItem(rows[i], it, `material ${i + 1}`))) return;
    const qty = pick([1, 2, 3.5, 12, 31, 0.75, 4.83]);
    typedQty.set(it.id, qty);
    await typeInto(
      dlg?.querySelectorAll('input[aria-label="Material quantity"]')[i],
      String(qty),
      `material ${i + 1} qty`,
    );
    const wBox = dlg?.querySelectorAll('input[aria-label="Wastage percent"]')[i] as
      HTMLElement | undefined;
    if (rand() < 0.3 && wBox && wBox.offsetParent !== null)
      await typeInto(
        dlg?.querySelectorAll('input[aria-label="Wastage percent"]')[i],
        String(pick([2, 5, 10])),
        `material ${i + 1} wastage`,
      );
  }
  const labour = pick([0, 350, 3000]);
  if (labour)
    await typeInto(dlg?.querySelector('input[aria-label="Cost amount"]'), String(labour), "labour");
  const name = `Monkey BOM ${++serial}`;
  const nameBox = Array.from(dlg?.querySelectorAll("input") ?? []).find(
    (i) => (i as HTMLInputElement).placeholder === "e.g. 3-seater — velvet",
  );
  await typeInto(nameBox, name, "BOM name");
  await clearToasts();
  await click(button(dlg, /^Save BOM$/), "Save BOM");
  await wait(250);
  const saved = BomRepo.all().find((b) => b.name === name);
  assert(
    BomRepo.all().length === before + 1 && !!saved,
    `the BOM was not saved — toasts: ${JSON.stringify(toasts())}`,
  );
  if (!saved) return;
  assert(saved.finishedItemId === finished.id, `saved for ${saved.finishedItemName}`);
  for (const [id, q] of typedQty) {
    const c = saved.components.find((x) => x.itemId === id);
    assert(!!c && close(c.qty, q), `${ItemRepo.get(id)?.name}: typed ${q}, saved ${c?.qty}`);
  }
  assert(!dialog(), "the dialog closes after a successful save");
}

async function editBom() {
  const b = pick(BomRepo.all().filter((x) => !x.archived));
  if (!b) return createBom();
  await go("/boms");
  if (
    !(await click(
      // A phone has no pencil — tapping the card opens it.
      rowWith(b.name)?.querySelector('button[title="Edit BOM"]') ?? rowWith(b.name),
      `edit "${b.name}"`,
    ))
  )
    return;
  const dlg = dialog();
  // A row cut as pieces has count/length boxes, not a quantity — edit one
  // that has a quantity box, and find ITS box among those that do.
  const editable = b.components.map((c, k) => ({ c, k })).filter((x) => !(b.sizing && x.c.cut));
  if (!editable.length)
    return notes.push(`${b.name}: every row is cut as pieces`) as unknown as void;
  const chosen = pick(editable);
  const i = chosen.k;
  const boxIdx = b.sizing ? editable.indexOf(chosen) : i;
  const newQty = pick([1.5, 2, 6, 9.25]);
  // A made-to-measure BOM has a formula box; a plain number is a formula too.
  await typeInto(
    dlg?.querySelectorAll(
      b.sizing ? 'input[aria-label="Quantity formula"]' : 'input[aria-label="Material quantity"]',
    )[boxIdx],
    String(newQty),
    "material qty (edit)",
  );
  let dropped: string | null = null;
  const removeBtns = Array.from(
    dlg?.querySelectorAll<HTMLElement>('button[title="Remove material"]') ?? [],
  );
  // A phone hides the remove buttons on these rows.
  if (b.components.length > 1 && rand() < 0.4 && removeBtns[0]?.offsetParent !== null) {
    const j = i === 0 ? 1 : 0;
    dropped = b.components[j].itemId;
    await click(dlg?.querySelectorAll('button[title="Remove material"]')[j], "remove material");
  }
  await clearToasts();
  await click(button(dlg, /^Save BOM$/), "Save BOM (edit)");
  await wait(250);
  const after = BomRepo.get(b.id);
  const target = after?.components.find((c) => c.itemId === b.components[i].itemId);
  assert(
    !!target && (b.sizing ? target.qtyFormula === String(newQty) : close(target.qty, newQty)),
    `edit: ${b.components[i].itemName} should be ${newQty}, is ${target?.qty} — toasts ${JSON.stringify(toasts())}`,
  );
  if (dropped)
    assert(
      !after?.components.some((c) => c.itemId === dropped),
      "edit: the removed material is gone",
    );
}

async function deleteBom() {
  const b = pick(BomRepo.all().filter((x) => !x.archived));
  if (!b) return;
  await go("/boms");
  const used = ProductionRepo.all().some((p) => p.bomId === b.id);
  await click(rowWith(b.name)?.querySelector('button[title="Delete BOM"]'), `delete "${b.name}"`);
  await wait(150);
  if (used)
    assert(
      BomRepo.get(b.id)?.archived === true,
      "a BOM with production runs is archived, not deleted",
    );
  else assert(!BomRepo.get(b.id), "an unused BOM is deleted");
}

async function createProduction() {
  const b = pick(BomRepo.all().filter((x) => !x.archived));
  if (!b) return createBom();
  await go("/productions");
  const before = ProductionRepo.all().length;
  const stockBefore = new Map(ItemRepo.all().map((i) => [i.id, num(i.stock)] as const));
  if (!(await click(button(document, /New production/), "New production button"))) return;
  const dlg = dialog();
  await click(dlg?.querySelector('[role="combobox"][aria-label="BOM"]'), "BOM chooser");
  const opt = Array.from(document.querySelectorAll('[role="option"]')).find((o) =>
    (o.textContent ?? "").includes(b.name),
  );
  if (!(await click(opt, `BOM option "${b.name}"`))) return;
  let qty = pick([1, 2, 3, 5]);
  let madeAt: { w: number; h: number; pieces: number } | null = null;
  if (b.sizing) {
    // Made to measure: the size and pieces, and the qty follows from them.
    madeAt = { w: pick([36, 48, 58, 72]), h: pick([35, 48, 60]), pieces: pick([1, 2]) };
    await typeInto(dlg?.querySelector('input[aria-label="Width"]'), String(madeAt.w), "width");
    await typeInto(dlg?.querySelector('input[aria-label="Height"]'), String(madeAt.h), "height");
    await typeInto(
      dlg?.querySelector('input[aria-label="Pieces"]'),
      String(madeAt.pieces),
      "pieces",
    );
    qty =
      Number(
        (dlg?.querySelector('input[aria-label="Quantity made"]') as HTMLInputElement | null)?.value,
      ) || 0;
  } else
    await typeInto(
      dlg?.querySelector('input[aria-label="Quantity made"]'),
      String(qty),
      "qty made",
    );
  await clearToasts();
  await click(button(dlg, /^Save production$/), "Save production");
  await wait(300);
  const runs = ProductionRepo.all();
  assert(runs.length === before + 1, `production not saved — toasts ${JSON.stringify(toasts())}`);
  const run = runs.find((p) => p.bomId === b.id && p.qty === qty);
  if (!run) return;
  const byId = new Map(ItemRepo.all().map((i) => [i.id, i] as const));
  const expected = madeAt
    ? consumptionForSize(
        b,
        { ...madeAt, unit: b.sizing?.formulaUnit ?? "in" },
        madeAt.pieces,
        byId,
        {
          constants: CompanyRepo.get().mtm?.constants,
          roundUpWhole: true,
        },
      ).lines
    : consumptionFor(b, qty, byId, true);
  for (const w of expected) {
    const got = run.components.find((c) => c.itemId === w.itemId);
    assert(
      !!got && close(got.qty, w.qty),
      `${w.itemName}: ${qty} made should use ${w.qty}, the run used ${got?.qty}`,
    );
  }
  assert(
    close(
      num(ItemRepo.get(b.finishedItemId)?.stock),
      (stockBefore.get(b.finishedItemId) ?? 0) + qty,
    ),
    `${b.finishedItemName}: +${qty} into stock`,
  );
}

/** By-length stock (slats, rails): sort unsorted length into sizes on the
 *  item's own page, with real clicks — and the sizes must add up. */
async function sortPieces() {
  const tracked = ItemRepo.all().filter((i) => i.pieces);
  if (!tracked.length) return;
  const it = pick(tracked);
  const loose = bagsOf(it, pieceDataFromRepos()).loose;
  const len = pick([1, 2, 5]);
  const count = Math.floor(Math.min(loose / len, 3));
  if (count < 1) return notes.push(`${it.name}: nothing unsorted to sort`) as unknown as void;
  await go(`/items/${it.id}`);
  const before = PieceSortRepo.all().length;
  if (!(await click(button(document, /^Sort into sizes$/), "Sort into sizes"))) return;
  const dlg = dialog();
  await typeInto(
    dlg?.querySelector('input[aria-label="Piece length"]'),
    String(len),
    "piece length",
  );
  await typeInto(
    dlg?.querySelector('input[aria-label="Piece count"]'),
    String(count),
    "piece count",
  );
  await clearToasts();
  await click(button(dialog(), /^Save$/), "Save sort");
  await wait(250);
  assert(
    PieceSortRepo.all().length === before + 1,
    `${it.name}: sorting ${count} × ${len} of ${loose} unsorted not saved — toasts ${JSON.stringify(toasts())}`,
  );
}

async function deleteProduction() {
  const p = pick(ProductionRepo.all());
  if (!p) return;
  await go("/productions");
  const row = rowWith(p.number);
  // The register shows the financial year, a page at a time.
  if (!row)
    return notes.push(`${p.number} not on the first page of the register`) as unknown as void;
  await click(row.querySelector('button[title="Delete production"]'), `delete ${p.number}`);
  await wait(250);
  // Refusing is right when a later run cut this one's offcuts.
  if (ProductionRepo.get(p.id) && toasts().some((t) => /offcuts were used/.test(t))) {
    notes.push(`${p.number}: delete refused — a later run used its offcuts (correct)`);
    return;
  }
  assert(
    !ProductionRepo.get(p.id),
    `${p.number} was not deleted — toasts ${JSON.stringify(toasts())}`,
  );
}

/* ── run ───────────────────────────────────────────────────────────────── */
export async function run(): Promise<Results> {
  try {
    const rootOptions = (routeTree as unknown as { options: Record<string, unknown> }).options;
    rootOptions.component = function TestRoot() {
      return (
        <>
          <Outlet />
          <Toaster position="top-center" duration={3000} closeButton richColors />
        </>
      );
    };
    rootOptions.shellComponent = ({ children }: { children: ReactNode }) => <>{children}</>;
    // Real input arrives outside act(); let React schedule normally.
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      false;
    globalThis.__TEST_IS_OWNER__ = true;
    // The runner dismisses native dialogs; a person deleting says yes.
    window.confirm = () => true;
    toastObserver.observe(document.body, { childList: true, subtree: true });

    seed();
    R.fails.push(`(seed ${SEED})`);
    stepLabel = "start";
    checkBooks();

    const STEPS = Number(G.__MONKEY_STEPS__ ?? 40);
    const actions: Array<[string, () => Promise<unknown>, number]> = [
      ["create item", createItem, 2],
      ["edit item", editItem, 1],
      ["delete item", deleteItem, 1],
      ["create party", createParty, 1],
      ["create sale", () => createBill("sale"), 5],
      ["create purchase", () => createBill("purchase"), 4],
      ["edit sale", () => editBill("sale"), 2],
      ["edit purchase", () => editBill("purchase"), 2],
      ["delete sale", () => deleteBill("sale"), 1],
      ["delete purchase", () => deleteBill("purchase"), 1],
      ["receive payment", () => createPayment("in"), 2],
      ["make payment", () => createPayment("out"), 2],
      ["delete payment", deletePayment, 1],
      ["create expense", createExpense, 1],
      ["delete expense", deleteExpense, 1],
      ["create BOM", createBom, 2],
      ["edit BOM", editBom, 1],
      ["delete BOM", deleteBom, 1],
      ["create production", createProduction, 2],
      ["delete production", deleteProduction, 1],
      ["sort pieces", sortPieces, 1],
    ];
    const bag = actions.flatMap(([n, f, w]) => Array.from({ length: w }, () => [n, f] as const));
    const counts = new Map<string, number>();
    for (let s = 1; s <= STEPS; s++) {
      const [name, fn] = pick(bag);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      stepLabel = `step ${s}: ${name}`;
      console.info(`[monkey] ${stepLabel}`);
      try {
        await fn();
      } catch (e) {
        assert(false, `threw: ${(e as Error)?.stack?.split("\n").slice(0, 3).join(" | ")}`);
      }
      try {
        checkBooks();
      } catch (e) {
        assert(false, `checking the books threw: ${(e as Error)?.message}`);
      }
    }
    stepLabel = "end";
    R.fails.push(
      `(ran: ${[...counts].map(([n, c]) => `${n} ×${c}`).join(", ")})`,
      `(books: ${SalesRepo.all().length} sales, ${PurchaseRepo.all().length} purchases, ${PaymentRepo.all().length} payments, ${ExpenseRepo.all().length} expenses, ${BomRepo.all().length} BOMs, ${ProductionRepo.all().length} runs, ${ItemRepo.all().length} items, ${PartyRepo.all().length} parties)`,
      ...[...new Set(notes)].slice(0, 20).map((n) => `(note) ${n}`),
    );
    return R;
  } catch (e) {
    R.failed++;
    R.fails.push(`aborted at ${stepLabel}: ${(e as Error)?.stack ?? String(e)}`);
    return R;
  }
}
