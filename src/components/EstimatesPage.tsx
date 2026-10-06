import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { EstimateRepo, CompanyRepo, nextEstimateNumber } from "@/repositories";
import { genId, newBatch, commitBatch } from "@/repositories/base";
import { useRepoData } from "@/hooks/useRepoData";
import { usePermissions } from "@/hooks/usePermissions";
import { useStickyState } from "@/hooks/useStickySearch";
import { fmtMoney, fmtDate, today } from "@/lib/format";
import {
  estimateSpec,
  isExpired,
  canConvert,
  carriedFields,
  type EstimateKind,
} from "@/lib/estimates";
import type { Estimate } from "@/types";
import { Search, Plus, FileText, ArrowRight, Trash2, Eye } from "lucide-react";
import { toast } from "sonner";

/**
 * Quotations and proforma invoices — one screen, told apart by `kind`.
 *
 * They are the same document at two stages of the same conversation, so a
 * second screen would be a second set of habits for no gain. What differs is
 * the heading, the numbering series and what "convert" produces.
 */
export function EstimatesPage({ kind }: { kind: EstimateKind }) {
  const _v = useRepoData();
  const navigate = useNavigate();
  const spec = estimateSpec(kind);
  const { isOwner, canEdit, canDelete } = usePermissions();
  const editAllowed = isOwner || canEdit("sales");
  const deleteAllowed = isOwner || canDelete("sales");

  const [rows, setRows] = useState<Estimate[]>([]);
  const [q, setQ] = useStickyState(`estimates.${kind}.search`, "");

  useEffect(() => {
    setRows(
      EstimateRepo.all()
        .filter((e) => e.kind === kind)
        .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")),
    );
  }, [_v, kind]);

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? rows.filter((e) =>
        [e.number, e.partyName].some((f) => (f ?? "").toLowerCase().includes(needle)),
      )
    : rows;

  /**
   * A quotation becomes a proforma by COPYING, never by relabelling.
   *
   * The quotation stays exactly as it was sent — the customer has a copy of it
   * — and the new document gets its own number in its own series. The link is
   * recorded both ways so the chain can be read from either end.
   */
  const makeProforma = (e: Estimate) => {
    const company = CompanyRepo.get();
    const id = genId();
    const number = nextEstimateNumber(
      company.proformaPrefix || estimateSpec("proforma").prefix,
      "proforma",
    );
    // The new proforma and marking the quotation converted must land
    // together — otherwise a failure between the two could leave a quotation
    // marked "open" after a proforma already exists from it (so it could be
    // converted again), or a proforma that exists with no record of where it
    // came from.
    const batch = newBatch();
    EstimateRepo.addBatched(batch, {
      ...(carriedFields(e as unknown as Record<string, unknown>) as Partial<Estimate>),
      id,
      kind: "proforma",
      status: "open",
      number,
      date: today(),
      subtotal: e.subtotal,
      taxAmount: e.taxAmount,
      roundOff: e.roundOff,
      total: e.total,
      fromId: e.id,
      fromNumber: e.number,
    } as Estimate);
    EstimateRepo.updateBatched(batch, e.id, {
      status: "converted",
      convertedToId: id,
      convertedToNumber: number,
      convertedToKind: "proforma",
    });
    commitBatch(batch, "create proforma").then((ok) => {
      if (!ok) {
        toast.error("Could not create the proforma — reload and check before trying again");
        return;
      }
      toast.success(`Proforma ${number} created from ${e.number}`);
      navigate({ to: "/proforma" });
    });
  };

  /* A proforma does not BECOME a tax invoice — a new one is raised. So this
     opens the bill screen with the deal already filled in, and the tax invoice
     takes its own number from its own series when it is saved. */
  const makeInvoice = (e: Estimate) => {
    navigate({ to: "/sales/new", search: { from: e.id } as never });
  };

  const remove = (e: Estimate) => {
    if (!confirm(`Delete ${spec.label} ${e.number}?`)) return;
    EstimateRepo.remove(e.id);
    toast.success(`${e.number} deleted`);
  };

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title={spec.plural}
        subtitle={`${rows.length} saved`}
        icon={<FileText className="h-5 w-5" />}
        actions={
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <div className="relative flex-1 sm:flex-none">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={q}
                onChange={(ev) => setQ(ev.target.value)}
                placeholder={`Search ${spec.plural.toLowerCase()}…`}
                className="h-9 w-full rounded-md border bg-background pl-8 pr-3 outline-none focus:border-primary focus:ring-2 focus:ring-ring/20 sm:w-64"
              />
            </div>
            {editAllowed && (
              <Button
                className="shrink-0"
                onClick={() => navigate({ to: "/sales/new", search: { doc: kind } as never })}
              >
                <Plus className="h-4 w-4" /> New
              </Button>
            )}
          </div>
        }
      />

      <div className="flex-1 overflow-auto p-4 sm:p-5">
        {shown.length === 0 ? (
          <div className="mx-auto max-w-md rounded-lg border bg-card px-6 py-12 text-center shadow-card">
            <FileText className="mx-auto h-10 w-10 text-muted-foreground/40" />
            <p className="mt-3 text-[15px] font-semibold">
              {rows.length === 0 ? `No ${spec.plural.toLowerCase()} yet` : "Nothing matches that"}
            </p>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {kind === "quotation"
                ? "A quotation is the price you send before there is an order. It carries no GST and moves no stock."
                : "A proforma is what you send once the deal is agreed — the document a customer's bank will accept. It is still not a tax invoice."}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border bg-card shadow-card">
            {shown.map((e) => {
              const expired = isExpired(e, today());
              return (
                <div
                  key={e.id}
                  className="flex flex-col gap-3 border-b px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-mono text-[13px] font-semibold">{e.number}</span>
                      <span className="text-[14px] font-semibold">{e.partyName}</span>
                      {e.status === "converted" && (
                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                          → {e.convertedToNumber}
                        </span>
                      )}
                      {/* A warning, not a state. The shop may still honour it. */}
                      {expired && e.status === "open" && (
                        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700">
                          Expired
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {fmtDate(e.date)}
                      {e.validUntil ? ` · valid until ${fmtDate(e.validUntil)}` : ""}
                      {e.fromNumber ? ` · from ${e.fromNumber}` : ""}
                    </p>
                  </div>

                  <div className="shrink-0 text-[15px] font-bold tabular-nums">
                    {fmtMoney(e.total)}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {/* Opens the DOCUMENT. This used to call window.print(),
                        which printed this list — useless for the one thing a
                        quotation exists to do, which is reach a customer. */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        navigate({
                          to: kind === "quotation" ? "/quotations/$id" : "/proforma/$id",
                          params: { id: e.id },
                        })
                      }
                    >
                      <Eye className="h-4 w-4" /> Open
                    </Button>
                    {editAllowed && canConvert(e) && (
                      <Button
                        size="sm"
                        onClick={() => (kind === "quotation" ? makeProforma(e) : makeInvoice(e))}
                      >
                        {kind === "quotation" ? "Make Proforma" : "Make Invoice"}
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    )}
                    {deleteAllowed && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10"
                        onClick={() => remove(e)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
