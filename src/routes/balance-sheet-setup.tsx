import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import {
  BsAccountRepo,
  CompanyRepo,
  ExpenseRepo,
  FinConfigRepo,
  ItemRepo,
  JournalVoucherRepo,
  areReposHydrated,
  nextInvoiceNumber,
} from "@/repositories";
import { newBatch, commitBatch, genId } from "@/repositories/base";
import { useRepoData, useRepoMemo } from "@/hooks/useRepoData";
import { usePermissions } from "@/hooks/usePermissions";
import { useFinancialYear } from "@/store/financialYear";
import { BS_GROUP_LABEL, registerOpenings, wdvDepreciation } from "@/lib/financials";
import { normalizeLedger } from "@/lib/postings";
import { stockSnapshots } from "@/lib/stockValuation";
import { FIN_CONFIG_ID, booksData, finInputFromRepos } from "@/lib/finData";
import { fmtMoney, fmtDate } from "@/lib/format";
import type { BsAccount, BsGroup, ExpenseClass, FinConfig } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/Field";
import { NumInput } from "@/components/NumInput";
import { ComboInput } from "@/components/ComboInput";
import { SelectMenu } from "@/components/SelectMenu";
import { SlidersHorizontal, Plus, Pencil, Trash2, Info, Scale } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/balance-sheet-setup")({ component: SetupPage });

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Group choices in the order a CA reads the balance sheet. */
const GROUP_OPTIONS: { value: BsGroup; label: string }[] = (
  [
    "capital",
    "drawings",
    "reserves",
    "securedLoan",
    "unsecuredLoan",
    "fixedAsset",
    "investment",
    "loansAdvances",
    "otherCurrentAsset",
    "otherCurrentLiability",
    "dutiesTaxes",
    "provision",
    "otherIncome",
    "indirectExpense",
    "directExpense",
  ] as BsGroup[]
).map((g) => ({ value: g, label: BS_GROUP_LABEL[g] }));

/** Income-tax WDV rates a CA most often needs for this kind of business. */
const RATE_PRESETS: { label: string; rate: number }[] = [
  { label: "Furniture & fittings", rate: 10 },
  { label: "Plant & machinery", rate: 15 },
  { label: "Motor vehicle", rate: 15 },
  { label: "Computer", rate: 40 },
  { label: "Building", rate: 10 },
];

const NO_OPENING: BsGroup[] = [
  "capital",
  "drawings",
  "otherIncome",
  "indirectExpense",
  "directExpense",
];

function SetupPage() {
  const { isOwner } = usePermissions();
  const _repoV = useRepoData();
  const fy = useFinancialYear();
  const [editing, setEditing] = useState<BsAccount | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [presetName, setPresetName] = useState("");

  const accounts = useRepoMemo(() =>
    BsAccountRepo.all().sort(
      (a, b) =>
        GROUP_OPTIONS.findIndex((g) => g.value === a.group) -
          GROUP_OPTIONS.findIndex((g) => g.value === b.group) || a.name.localeCompare(b.name),
    ),
  );
  const config = useRepoMemo(() => FinConfigRepo.get(FIN_CONFIG_ID));
  const registered = new Set(accounts.map((a) => normalizeLedger(a.name)));

  // Every ledger name typed in a Journal Voucher, with how often it is used.
  const ledgerUse = useRepoMemo(() => {
    const m = new Map<string, { name: string; count: number }>();
    for (const jv of JournalVoucherRepo.all())
      for (const l of jv.lines) {
        if (l.kind !== "ledger") continue;
        const name = (l.refName || l.refId || "").trim();
        if (!name) continue;
        const k = normalizeLedger(name);
        const e = m.get(k) ?? { name, count: 0 };
        e.count++;
        m.set(k, e);
      }
    return m;
  });
  const unclassified = [...ledgerUse.entries()]
    .filter(([k]) => !registered.has(k))
    .map(([, v]) => v)
    .sort((a, b) => b.count - a.count);

  const categories = useRepoMemo(() => {
    const set = new Set<string>(CompanyRepo.get().expenseCategories ?? []);
    for (const e of ExpenseRepo.all()) if (e.category?.trim()) set.add(e.category.trim());
    for (const jv of JournalVoucherRepo.all())
      for (const l of jv.lines) if (l.kind === "expense" && l.refName) set.add(l.refName.trim());
    return [...set].sort((a, b) => a.localeCompare(b));
  });

  void _repoV;
  if (!isOwner) return null; // the root gate already blocks; belt and braces

  const saveConfig = (patch: Partial<FinConfig>) => {
    const existing = FinConfigRepo.get(FIN_CONFIG_ID);
    if (existing) FinConfigRepo.update(FIN_CONFIG_ID, patch);
    else FinConfigRepo.add({ id: FIN_CONFIG_ID, ...patch });
  };

  const removeAccount = (a: BsAccount) => {
    const used = ledgerUse.get(normalizeLedger(a.name))?.count ?? 0;
    const msg = used
      ? `Remove "${a.name}" from the register? ${used} journal voucher line(s) use it — they will show under Suspense until it is classified again. No entry is deleted.`
      : `Remove "${a.name}" from the register?`;
    if (!confirm(msg)) return;
    BsAccountRepo.remove(a.id);
    toast.success("Removed from the register");
  };

  return (
    <div className="flex flex-col h-full overflow-auto">
      <PageHeader
        title="Balance Sheet Setup"
        subtitle="Capital, drawings, loans and fixed assets — what the balance sheet needs beyond your bills"
        icon={<SlidersHorizontal className="h-5 w-5" />}
        actions={
          <Link to="/financials">
            <Button size="sm" variant="outline">
              <Scale className="h-3.5 w-3.5" /> Open Balance Sheet
            </Button>
          </Link>
        }
      />
      <div className="p-4 md:p-6 flex flex-col gap-5 max-w-5xl">
        <BooksStart config={config} onSave={(d) => saveConfig({ booksStartDate: d })} />

        <Card
          title="Accounts register"
          hint="Each account is a ledger name you use in Journal Vouchers. Its group decides where it appears on the balance sheet. Opening balances are as on the books-start date."
          action={
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setPresetName("");
                setDialogOpen(true);
              }}
            >
              <Plus className="h-3.5 w-3.5" /> Add account
            </Button>
          }
        >
          {accounts.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground py-3">
              No accounts yet. Typical: Capital, Drawings, a bank/vehicle loan, Machinery,
              Furniture, Security deposit, Depreciation.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-1.5 pr-2 font-medium">Account</th>
                    <th className="py-1.5 pr-2 font-medium">Group</th>
                    <th className="py-1.5 pr-2 font-medium text-right">Opening</th>
                    <th className="py-1.5 pr-2 font-medium text-right">Dep. %</th>
                    <th className="py-1.5 pr-2 font-medium text-right">JV lines</th>
                    <th className="py-1.5 w-16" />
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-2 font-medium">{a.name}</td>
                      <td className="py-1.5 pr-2 text-muted-foreground">
                        {BS_GROUP_LABEL[a.group]}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">
                        {a.openingBalance
                          ? `${fmtMoney(a.openingBalance)} ${a.openingSide === "cr" ? "Cr" : "Dr"}`
                          : "—"}
                      </td>
                      <td className="py-1.5 pr-2 text-right">
                        {a.group === "fixedAsset" ? `${a.depreciationRate ?? 0}%` : ""}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">
                        {ledgerUse.get(normalizeLedger(a.name))?.count ?? 0}
                      </td>
                      <td className="py-1.5 text-right whitespace-nowrap">
                        <button
                          onClick={() => {
                            setEditing(a);
                            setDialogOpen(true);
                          }}
                          className="h-7 w-7 inline-flex items-center justify-center rounded text-gray-400 hover:text-primary hover:bg-primary-soft"
                          title="Edit"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => removeAccount(a)}
                          className="h-7 w-7 inline-flex items-center justify-center rounded text-gray-400 hover:text-rose-600 hover:bg-rose-50"
                          title="Remove"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {unclassified.length > 0 && (
          <Card
            title={`Journal voucher ledgers not yet classified (${unclassified.length})`}
            hint="Until classified these sit under Suspense on the balance sheet. Choose what each one is."
            tone="warn"
          >
            <div className="flex flex-col divide-y">
              {unclassified.map((u) => (
                <UnclassifiedRow key={u.name} name={u.name} count={u.count} />
              ))}
            </div>
          </Card>
        )}

        <Card
          title="Expense categories"
          hint="How each expense category is reported. Most are ordinary expenses; workshop wages and freight-in are direct costs (Trading account); the owner's personal spending is Drawings; tax deposited can go against a register account such as GST Payable."
        >
          <div className="flex flex-col divide-y">
            {categories.map((c) => (
              <ExpenseClassRow
                key={c}
                category={c}
                value={config?.expenseClass?.[c] ?? "indirect"}
                accounts={accounts}
                onChange={(v) =>
                  saveConfig({ expenseClass: { ...(config?.expenseClass ?? {}), [c]: v } })
                }
              />
            ))}
          </div>
        </Card>

        <DepreciationCard fy={fy} accounts={accounts} />

        <OpeningRatesCard />

        <Card title="How to record the everyday movements" tone="info">
          <ul className="text-[12.5px] leading-relaxed list-disc pl-5 text-muted-foreground">
            <li>
              <b className="text-foreground">Owner brings money in:</b> Journal Voucher — Dr Bank
              (or Cash), Cr <i>Capital</i>.
            </li>
            <li>
              <b className="text-foreground">Owner takes money / pays personal bills:</b> Dr{" "}
              <i>Drawings</i>, Cr Cash or Bank.
            </li>
            <li>
              <b className="text-foreground">Loan received:</b> Dr Bank, Cr <i>HDFC Loan</i>{" "}
              (secured/unsecured loan). <b className="text-foreground">EMI paid:</b> Dr{" "}
              <i>HDFC Loan</i> (principal) + Dr <i>Interest on Loan</i> (indirect expense), Cr Bank.
            </li>
            <li>
              <b className="text-foreground">Machine / furniture / vehicle bought:</b> Dr{" "}
              <i>Machinery</i> (fixed asset), Cr Bank or the supplier party — not a Purchase bill,
              which would put it into stock.
            </li>
            <li>
              <b className="text-foreground">Depreciation:</b> use the helper above at year end.
            </li>
          </ul>
          <Link
            to="/journal-vouchers"
            className="text-[12.5px] text-primary font-medium mt-2 inline-block"
          >
            Go to Journal Vouchers →
          </Link>
        </Card>
      </div>

      <AccountDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        account={editing}
        presetName={presetName}
        suggestions={[
          ...unclassified.map((u) => u.name),
          ...(CompanyRepo.get().journalLedgerAccounts ?? []),
        ]}
        existing={accounts}
      />
    </div>
  );
}

function Card({
  title,
  hint,
  action,
  tone,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  tone?: "warn" | "info";
  children: React.ReactNode;
}) {
  const border =
    tone === "warn" ? "border-amber-200" : tone === "info" ? "border-sky-200" : "border-border";
  return (
    <section className={`rounded-lg border ${border} bg-card p-4`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <h2 className="text-[14px] font-semibold">{title}</h2>
          {hint && <p className="text-[12px] text-muted-foreground mt-0.5 max-w-3xl">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function BooksStart({
  config,
  onSave,
}: {
  config: FinConfig | undefined;
  onSave: (date: string) => void;
}) {
  const [date, setDate] = useState(config?.booksStartDate ?? "");
  useEffect(() => setDate(config?.booksStartDate ?? ""), [config?.booksStartDate]);
  return (
    <Card
      title="Books start date"
      hint="The date your opening balances (parties, banks, opening stock and the register below) are as on — usually the 1 April you started using this app."
    >
      <div className="flex items-end gap-2">
        <div className="w-48">
          <Field type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <Button
          size="sm"
          disabled={!date || date === config?.booksStartDate}
          onClick={() => {
            onSave(date);
            toast.success("Books start date saved");
          }}
        >
          Save
        </Button>
        {config?.booksStartDate && (
          <span className="text-[12px] text-muted-foreground mb-1.5">
            Opening balances are as on {fmtDate(config.booksStartDate)}
          </span>
        )}
      </div>
    </Card>
  );
}

function UnclassifiedRow({ name, count }: { name: string; count: number }) {
  const [group, setGroup] = useState<BsGroup>(guessGroup(name));
  return (
    <div className="flex items-center gap-3 py-2 flex-wrap">
      <span className="font-medium text-[13px] min-w-40">{name}</span>
      <span className="text-[11.5px] text-muted-foreground">{count} JV line(s)</span>
      <div className="ml-auto flex items-center gap-2">
        <SelectMenu<BsGroup>
          value={group}
          options={GROUP_OPTIONS}
          onChange={setGroup}
          ariaLabel={`Group for ${name}`}
          align="right"
          className="h-8 px-2 text-[12.5px]"
        />
        <Button
          size="sm"
          onClick={() => {
            BsAccountRepo.add({ name, group });
            toast.success(`"${name}" classified as ${BS_GROUP_LABEL[group]}`);
          }}
        >
          Classify
        </Button>
      </div>
    </div>
  );
}

/** A first guess from the name — the owner confirms it. */
function guessGroup(name: string): BsGroup {
  const n = name.toLowerCase();
  if (/drawing/.test(n)) return "drawings";
  if (/capital/.test(n)) return "capital";
  if (/depreciat|interest paid|interest on|bank charge/.test(n)) return "indirectExpense";
  if (/interest (received|income)|commission|rent received|discount received/.test(n))
    return "otherIncome";
  if (/loan|od\b|overdraft|cc limit/.test(n)) return "securedLoan";
  if (/gst|tds|tcs|tax/.test(n)) return "dutiesTaxes";
  if (/machin|furniture|vehicle|car|computer|building|equipment|plant/.test(n)) return "fixedAsset";
  if (/deposit|advance/.test(n)) return "loansAdvances";
  if (/provision/.test(n)) return "provision";
  return "otherCurrentLiability";
}

function ExpenseClassRow({
  category,
  value,
  accounts,
  onChange,
}: {
  category: string;
  value: ExpenseClass;
  accounts: BsAccount[];
  onChange: (v: ExpenseClass) => void;
}) {
  const options: { value: string; label: string }[] = [
    { value: "indirect", label: "Expense (Profit & Loss)" },
    { value: "direct", label: "Direct cost (Trading account)" },
    { value: "drawings", label: "Owner's drawings" },
    ...accounts
      .filter((a) => !["capital", "drawings", "otherIncome"].includes(a.group))
      .map((a) => ({ value: `account:${a.name}`, label: `→ ${a.name}` })),
  ];
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 flex-wrap">
      <span className="text-[13px]">{category}</span>
      <SelectMenu<string>
        value={options.some((o) => o.value === value) ? value : "indirect"}
        options={options}
        onChange={(v) => onChange(v as ExpenseClass)}
        ariaLabel={`Class of ${category}`}
        align="right"
        className="h-8 px-2 text-[12.5px] min-w-52 justify-between"
      />
    </div>
  );
}

function DepreciationCard({
  fy,
  accounts,
}: {
  fy: { key: string; from: string; to: string; label: string };
  accounts: BsAccount[];
}) {
  const assets = accounts.filter((a) => a.group === "fixedAsset");
  const rows = useRepoMemo(() => {
    if (!assets.length) return [];
    const input = finInputFromRepos();
    const postings = [...input.books.postings, ...registerOpenings(input.accounts)];
    const jvs = JournalVoucherRepo.all();
    return assets.map((a) => {
      const calc = wdvDepreciation(a, postings, fy.from, fy.to);
      const norm = normalizeLedger(a.name);
      const posted = jvs
        .filter((jv) => jv.date >= fy.from && jv.date <= fy.to && /depreciat/i.test(jv.narration))
        .reduce(
          (s, jv) =>
            s +
            jv.lines
              .filter((l) => l.kind === "ledger" && normalizeLedger(l.refName) === norm)
              .reduce((x, l) => x + (l.credit || 0), 0),
          0,
        );
      return { a, calc, posted: r2(posted) };
    });
  }, [fy.from, fy.to, accounts]);

  const post = (a: BsAccount, amount: number) => {
    if (!areReposHydrated()) {
      toast.error("Still loading your data — try again in a moment");
      return;
    }
    if (
      !confirm(
        `Post depreciation of ${fmtMoney(amount)} on "${a.name}" for ${fy.label}?\n\nThis saves a Journal Voucher dated ${fmtDate(fy.to)}: Dr Depreciation, Cr ${a.name}.`,
      )
    )
      return;
    const batch = newBatch();
    if (!BsAccountRepo.all().some((x) => normalizeLedger(x.name) === "depreciation")) {
      BsAccountRepo.addBatched(batch, { name: "Depreciation", group: "indirectExpense" });
    }
    const company = CompanyRepo.get();
    JournalVoucherRepo.addBatched(batch, {
      number: nextInvoiceNumber(company.journalVoucherPrefix || "JV-", JournalVoucherRepo.all()),
      date: fy.to,
      narration: `Depreciation ${fy.label} — ${a.name} @ ${a.depreciationRate ?? 0}% (WDV)`,
      lines: [
        {
          id: genId(),
          kind: "ledger",
          refId: "Depreciation",
          refName: "Depreciation",
          debit: amount,
          credit: 0,
        },
        { id: genId(), kind: "ledger", refId: a.name, refName: a.name, debit: 0, credit: amount },
      ],
    });
    commitBatch(batch, "post depreciation").then((ok) => {
      if (ok) toast.success(`Depreciation posted on ${a.name}`);
    });
  };

  return (
    <Card
      title={`Depreciation — ${fy.label}`}
      hint="Income-tax written-down-value method: full rate on the opening value and on additions used 180 days or more in the year, half rate on later additions. Posting saves a Journal Voucher, so it can never be counted twice."
    >
      {assets.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground py-2">
          Add your fixed assets (group "Fixed asset", with a rate) to the register first.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-muted-foreground border-b">
                <th className="py-1.5 pr-2 font-medium">Asset</th>
                <th className="py-1.5 pr-2 font-medium text-right">Rate</th>
                <th className="py-1.5 pr-2 font-medium text-right">Full-rate base</th>
                <th className="py-1.5 pr-2 font-medium text-right">Half-rate base</th>
                <th className="py-1.5 pr-2 font-medium text-right">Depreciation</th>
                <th className="py-1.5 font-medium text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ a, calc, posted }) => (
                <tr key={a.id} className="border-b last:border-0">
                  <td className="py-1.5 pr-2 font-medium">{a.name}</td>
                  <td className="py-1.5 pr-2 text-right">{a.depreciationRate ?? 0}%</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtMoney(calc.base)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{fmtMoney(calc.halfBase)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums font-semibold">
                    {fmtMoney(calc.depreciation)}
                  </td>
                  <td className="py-1.5 text-right">
                    {posted > 0 ? (
                      <span className="text-emerald-700 text-[12px]">
                        Posted {fmtMoney(posted)}
                      </span>
                    ) : calc.depreciation > 0 ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => post(a, calc.depreciation)}
                      >
                        Post JV
                      </Button>
                    ) : (
                      <span className="text-muted-foreground text-[12px]">Nothing to post</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function OpeningRatesCard() {
  const pending = useRepoMemo(() =>
    ItemRepo.all().filter((i) => (i.openingStock || 0) > 0 && i.openingRate === undefined),
  );
  const [busy, setBusy] = useState(false);
  const freeze = async () => {
    if (!areReposHydrated()) {
      toast.error("Still loading your data — try again in a moment");
      return;
    }
    if (
      !confirm(
        `Record an opening cost for ${pending.length} item(s)?\n\nEach gets the cost the balance sheet is using for its opening stock today (its first purchase or production rate, else its purchase price). Fixing it stops later purchases from changing last year's figures. Stock quantities are not touched.`,
      )
    )
      return;
    setBusy(true);
    const [opening] = stockSnapshots(booksData(), ["0000-01-01"]);
    const rate = new Map(opening.items.map((p) => [p.itemId, p.rate] as const));
    let ok = true;
    for (let i = 0; i < pending.length && ok; i += 400) {
      const batch = newBatch();
      for (const it of pending.slice(i, i + 400)) {
        // adjustField's merge write: never rewrites the stock figure itself.
        ItemRepo.adjustFieldBatched(batch, it.id, "stock", 0, {
          openingRate: rate.get(it.id) ?? 0,
        });
      }
      ok = await commitBatch(batch, "record opening rates");
    }
    setBusy(false);
    if (ok) toast.success("Opening costs recorded");
  };
  return (
    <Card
      title="Opening stock cost"
      hint="Opening stock is valued at its cost per unit. Items without one recorded borrow their first purchase rate — which a new purchase can change. Recording it once keeps last year's balance sheet fixed."
    >
      <div className="flex items-center gap-3">
        <span className="text-[12.5px]">
          {pending.length
            ? `${pending.length} item(s) with opening stock have no opening cost recorded.`
            : "Every item with opening stock has its opening cost recorded."}
        </span>
        {pending.length > 0 && (
          <Button size="sm" variant="outline" disabled={busy} onClick={freeze}>
            {busy ? "Recording…" : "Record opening costs"}
          </Button>
        )}
      </div>
    </Card>
  );
}

function AccountDialog({
  open,
  onOpenChange,
  account,
  presetName,
  suggestions,
  existing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  account: BsAccount | null;
  presetName: string;
  suggestions: string[];
  existing: BsAccount[];
}) {
  const [name, setName] = useState("");
  const [group, setGroup] = useState<BsGroup>("securedLoan");
  const [opening, setOpening] = useState(0);
  const [side, setSide] = useState<"dr" | "cr">("cr");
  const [rate, setRate] = useState(0);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(account?.name ?? presetName);
    setGroup(account?.group ?? "securedLoan");
    setOpening(account?.openingBalance ?? 0);
    setSide(account?.openingSide ?? "cr");
    setRate(account?.depreciationRate ?? 0);
    setNotes(account?.notes ?? "");
  }, [open, account, presetName]);

  const assetLike = ["fixedAsset", "investment", "loansAdvances", "otherCurrentAsset"].includes(
    group,
  );
  const save = () => {
    const n = name.trim();
    if (!n) {
      toast.error("Name required");
      return;
    }
    const clash = existing.find(
      (x) => normalizeLedger(x.name) === normalizeLedger(n) && x.id !== account?.id,
    );
    if (clash) {
      toast.error(`"${clash.name}" is already in the register`);
      return;
    }
    const record = {
      name: n,
      group,
      openingBalance: NO_OPENING.includes(group) ? undefined : r2(opening) || undefined,
      openingSide: NO_OPENING.includes(group) || !opening ? undefined : side,
      depreciationRate: group === "fixedAsset" ? r2(rate) : undefined,
      notes: notes.trim() || undefined,
    };
    if (account) BsAccountRepo.update(account.id, record);
    else BsAccountRepo.add(record);
    toast.success(account ? "Account updated" : "Account added");
    onOpenChange(false);
  };

  const inputCls =
    "h-9 sm:h-8 w-full px-2 border rounded bg-background text-[16px] sm:text-[13px] outline-none focus:border-primary focus:ring-1 focus:ring-primary";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{account ? `Edit ${account.name}` : "Add register account"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 min-w-0">
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="text-muted-foreground font-medium">
              Name (exactly as used in Journal Vouchers) *
            </span>
            <ComboInput
              value={name}
              onValue={setName}
              options={suggestions}
              ariaLabel="Account name"
              placeholder="e.g. HDFC Car Loan"
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="text-muted-foreground font-medium">Group</span>
            <SelectMenu<BsGroup>
              value={group}
              options={GROUP_OPTIONS}
              onChange={(g) => {
                setGroup(g);
                setSide(
                  ["fixedAsset", "investment", "loansAdvances", "otherCurrentAsset"].includes(g)
                    ? "dr"
                    : "cr",
                );
              }}
              ariaLabel="Group"
              className="w-full h-9 sm:h-8 px-2 justify-between text-[16px] sm:text-[13px]"
            />
          </label>
          {!NO_OPENING.includes(group) && (
            <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-2 items-end">
              <label className="flex flex-col gap-1 text-[12px]">
                <span className="text-muted-foreground font-medium">
                  Opening balance (on books-start date)
                </span>
                <NumInput value={opening} onValue={setOpening} className={inputCls} />
              </label>
              <SelectMenu<"dr" | "cr">
                value={side}
                options={[
                  { value: "dr", label: assetLike ? "Dr (normal)" : "Dr" },
                  { value: "cr", label: assetLike ? "Cr" : "Cr (normal)" },
                ]}
                onChange={setSide}
                ariaLabel="Opening side"
                className="w-full h-9 sm:h-8 px-2 justify-between text-[13px]"
              />
            </div>
          )}
          {group === "fixedAsset" && (
            <div className="flex flex-col gap-1.5">
              <label className="flex flex-col gap-1 text-[12px] w-40">
                <span className="text-muted-foreground font-medium">Depreciation rate % (WDV)</span>
                <NumInput value={rate} onValue={setRate} className={inputCls} />
              </label>
              <div className="flex flex-wrap gap-1.5">
                {RATE_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setRate(p.rate)}
                    className={`text-[11.5px] px-2 py-0.5 rounded-full border ${rate === p.rate ? "bg-primary-soft border-primary/30 text-primary" : "text-muted-foreground"}`}
                  >
                    {p.label} {p.rate}%
                  </button>
                ))}
              </div>
            </div>
          )}
          {NO_OPENING.includes(group) && (
            <p className="text-[11.5px] text-muted-foreground flex gap-1.5">
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              {group === "capital" || group === "drawings"
                ? "No opening figure: opening capital is what your opening balances add up to. Movements come from Journal Vouchers."
                : "An income/expense head has no opening balance — only the year's entries."}
            </p>
          )}
          <Field label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="flex justify-end gap-2 mt-1">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={save}>Save</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
