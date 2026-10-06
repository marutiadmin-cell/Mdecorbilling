import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { PrintableInvoice } from "@/components/PrintableInvoice";
import { EstimateRepo, CompanyRepo } from "@/repositories";
import { useRepoData } from "@/hooks/useRepoData";
import { downloadElementAsPdf } from "@/lib/pdf";
import { printWithName, isStandalone } from "@/lib/print";
import { sendElementViaWhatsApp } from "@/lib/whatsappSend";
import {
  estimateSpec,
  isExpired,
  advanceAgainst,
  balanceAfterAdvance,
  type EstimateKind,
} from "@/lib/estimates";
import { RecordAdvanceDialog } from "@/components/RecordAdvanceDialog";
import { PaymentRepo } from "@/repositories";
import { fmtDate, fmtMoney, today } from "@/lib/format";
import type { Estimate, Invoice, Company } from "@/types";
import { Printer, Download, Send, FileText, IndianRupee } from "lucide-react";
import { toast } from "sonner";

/**
 * One quotation or proforma, as the customer will receive it.
 *
 * The list used to offer a Print button that called window.print() — which
 * prints the LIST. A quotation exists to be sent to somebody, so this is the
 * screen that actually does that: the document itself, printable, downloadable
 * and sendable, exactly like an invoice.
 *
 * The printed layout is the invoice's, with the heading and the disclaimer
 * passed in. Not because it is convenient — because a proforma is SUPPOSED to
 * look like an invoice, and the only things that may differ are the heading,
 * the validity and the line saying what it is not.
 */
export function EstimateDetail({ kind, id }: { kind: EstimateKind; id: string }) {
  const _v = useRepoData();
  const navigate = useNavigate();
  const spec = estimateSpec(kind);
  const printRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<Estimate | null>(null);
  const [co, setCo] = useState<Company | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [advanceOpen, setAdvanceOpen] = useState(false);

  useEffect(() => {
    setDoc(EstimateRepo.get(id) ?? null);
    setCo(CompanyRepo.get());
  }, [id, _v]);

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        This {spec.label.toLowerCase()} no longer exists.
      </div>
    );
  }

  /* The printed layout takes an Invoice. An Estimate is the same shape from
     the party down, which is what lets one layout serve all three documents —
     the cast is that sameness, not a shortcut around it. */
  const asInvoice = doc as unknown as Invoice;
  const expired = isExpired(doc, today());
  /* Only a proforma takes an advance. A quotation is a price, not yet a deal
     — money against one is money against nothing agreed. */
  const takesAdvance = kind === "proforma";
  const advance = advanceAgainst(doc.id, PaymentRepo.all());
  const stillDue = balanceAfterAdvance(doc.total, advance);

  const doPrint = () => {
    if (isStandalone()) return doDownload();
    printWithName(doc.number);
  };

  const doDownload = async () => {
    if (!printRef.current || busy) return;
    setBusy("download");
    try {
      await downloadElementAsPdf(printRef.current, doc.number, "portrait");
      toast.success(`${spec.label} downloaded`);
    } catch {
      toast.error("Could not generate the PDF — try Print instead");
    } finally {
      setBusy(null);
    }
  };

  const doSend = async () => {
    if (!printRef.current || busy) return;
    setBusy("send");
    try {
      const outcome = await sendElementViaWhatsApp({
        el: printRef.current,
        phone: doc.partyPhone,
        message: `Hi ${doc.partyName}, here is ${spec.label.toLowerCase()} ${doc.number}${
          doc.validUntil ? ` — valid until ${fmtDate(doc.validUntil)}` : ""
        }.`,
        fileName: doc.number,
        label: doc.number,
        orientation: "portrait",
      });
      if (outcome.status === "sent") {
        if (outcome.acknowledged) toast.success(`${spec.label} sent on WhatsApp`);
        else toast.info(`${spec.label} handed to WhatsApp — not confirmed delivered yet`);
      } else toast.info(outcome.message, { duration: 8000 });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send on WhatsApp");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={`${spec.label} ${doc.number}`}
        subtitle={`${doc.partyName} · ${fmtDate(doc.date)}${
          doc.validUntil ? ` · valid until ${fmtDate(doc.validUntil)}` : ""
        }`}
        icon={<FileText className="h-5 w-5" />}
        showBack
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={doPrint} disabled={!!busy}>
              <Printer className="h-4 w-4" /> Print
            </Button>
            <Button variant="outline" onClick={doDownload} disabled={!!busy}>
              <Download className="h-4 w-4" /> {busy === "download" ? "…" : "PDF"}
            </Button>
            <Button onClick={doSend} disabled={!!busy}>
              <Send className="h-4 w-4" /> {busy === "send" ? "Sending…" : "WhatsApp"}
            </Button>
            {takesAdvance && (
              <Button variant="outline" onClick={() => setAdvanceOpen(true)} disabled={!!busy}>
                <IndianRupee className="h-4 w-4" /> Advance
              </Button>
            )}
          </div>
        }
      />

      <div className="flex-1 overflow-auto bg-muted/30 p-4 sm:p-5">
        {expired && doc.status === "open" && (
          <div className="mx-auto mb-3 max-w-[820px] rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
            The price on this {spec.label.toLowerCase()} was only good until{" "}
            {fmtDate(doc.validUntil!)}. You can still honour it — this is a note, not a block.
          </div>
        )}
        {takesAdvance && advance > 0 && (
          <div className="mx-auto mb-3 flex max-w-[820px] flex-wrap items-center justify-between gap-2 rounded-md border bg-card px-3 py-2.5 text-[13px] shadow-card">
            <span>
              Advance received{" "}
              <strong className="tabular-nums text-emerald-700">{fmtMoney(advance)}</strong> of{" "}
              <span className="tabular-nums">{fmtMoney(doc.total)}</span>
            </span>
            <span className="text-muted-foreground">
              {stillDue > 0 ? (
                <>
                  Still to come <strong className="tabular-nums">{fmtMoney(stillDue)}</strong>
                </>
              ) : (
                "Paid in full"
              )}
            </span>
          </div>
        )}
        {doc.status === "converted" && (
          <div className="mx-auto mb-3 max-w-[820px] rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800">
            Already taken forward as {doc.convertedToNumber}.
          </div>
        )}
        <div className="mx-auto max-w-[820px] bg-white shadow-card">
          <div ref={printRef} className="print-visible">
            <PrintableInvoice
              inv={asInvoice}
              company={co ?? ({ name: "" } as Company)}
              mode="sale"
              className="print-visible"
              heading={spec.heading}
              disclaimer={spec.disclaimer}
              validUntil={doc.validUntil}
            />
          </div>
        </div>
      </div>

      {takesAdvance && (
        <RecordAdvanceDialog doc={doc} open={advanceOpen} onOpenChange={setAdvanceOpen} />
      )}

      <div className="border-t bg-card px-4 py-2.5 sm:hidden">
        <Button variant="outline" className="w-full" onClick={() => navigate({ to: ".." })}>
          Back
        </Button>
      </div>
    </div>
  );
}
