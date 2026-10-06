import { createFileRoute } from "@tanstack/react-router";
import { InvoiceForm } from "@/components/InvoiceForm";
import type { EstimateKind } from "@/lib/estimates";

/**
 * One screen writes all three sale-side documents.
 *
 * `?doc=` chooses which — a quotation, a proforma, or (absent) a tax invoice.
 * `?from=` is a proforma being turned into a tax invoice: the deal is copied
 * in, and the invoice takes its own number from its own series when saved. A
 * proforma is never relabelled into an invoice; a new one is raised.
 */
export const Route = createFileRoute("/sales/new")({
  /* Keys are OMITTED rather than set to undefined. A validator that always
     returns both makes them required at every navigate() in the app — the
     dashboard's Add Sale, the topbar, the keyboard shortcut — none of which
     has an opinion about either. */
  validateSearch: (search: Record<string, unknown>): { doc?: EstimateKind; from?: string } => {
    const out: { doc?: EstimateKind; from?: string } = {};
    if (search.doc === "quotation" || search.doc === "proforma") out.doc = search.doc;
    if (typeof search.from === "string" && search.from) out.from = search.from;
    return out;
  },
  component: NewSale,
});

function NewSale() {
  const { doc, from } = Route.useSearch();
  return <InvoiceForm mode="sale" initialDocType={doc} fromEstimateId={from} />;
}
