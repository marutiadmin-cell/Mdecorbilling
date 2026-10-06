import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/Field";
import { NumInput } from "@/components/NumInput";
import { ModePills } from "@/components/ModePills";
import { PaymentRepo, BankRepo } from "@/repositories";
import { genId, newBatch, commitBatch } from "@/repositories/base";
import { useRepoMemo } from "@/hooks/useRepoData";
import { today, fmtMoney } from "@/lib/format";
import type { Estimate, Payment, PaymentMode, BankAccount } from "@/types";
import { toast } from "sonner";

/**
 * Money taken against a proforma.
 *
 * This writes an ORDINARY RECEIPT. It moves the customer's balance and the
 * cash or bank account exactly as a receipt entered on the Payments screen
 * does, and it carries no allocation — because a proforma is not a
 * receivable and nothing can be settled against one.
 *
 * What it adds is a label: which proforma prompted it. That is the whole
 * feature. The money is an advance sitting on the customer's account, which
 * is where it belongs and where it already worked; the shop simply could not
 * see, from the proforma, that any had come in.
 */
export function RecordAdvanceDialog({
  doc,
  open,
  onOpenChange,
}: {
  doc: Estimate;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const banks = useRepoMemo<BankAccount[]>(() => BankRepo.all());
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(today());
  const [mode, setMode] = useState<PaymentMode>("cash");
  const [bankId, setBankId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setAmount(0);
      setDate(today());
      setMode("cash");
      setBankId(banks[0]?.id ?? "");
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = () => {
    if (saving) return;
    if (!(amount > 0)) {
      toast.error("Enter the amount received.");
      return;
    }
    if (mode === "bank" && !bankId) {
      toast.error("Choose which account it went into.");
      return;
    }
    setSaving(true);
    try {
      const batch = newBatch();
      // Money in, on whichever account took it. Same adjustment the Payments
      // screen makes — there is one way money moves in this app.
      if (mode === "bank" && bankId) {
        BankRepo.adjustFieldBatched(batch, bankId, "balance", amount);
      }
      const payment: Payment = {
        id: genId(),
        date,
        partyId: doc.partyId,
        partyName: doc.partyName,
        type: "in",
        amount,
        mode,
        bankId: mode === "bank" ? bankId : undefined,
        // No allocations. It is an advance: real money on the customer's
        // account, not applied to any bill, because no bill exists yet.
        againstEstimateId: doc.id,
        againstEstimateNumber: doc.number,
        createdAt: new Date().toISOString(),
      };
      PaymentRepo.addBatched(batch, payment);
      commitBatch(batch, "record advance").then((ok) => {
        setSaving(false);
        if (!ok) {
          toast.error("Could not record the advance — reload and check before trying again");
          return;
        }
        toast.success(`${fmtMoney(amount)} received against ${doc.number}`);
        onOpenChange(false);
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record the advance");
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Advance against {doc.number}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="font-medium text-muted-foreground">Amount received *</span>
            <NumInput
              value={amount}
              onValue={setAmount}
              className="h-11 w-full rounded border bg-background px-3 text-right text-[16px] tabular-nums outline-none focus:border-primary sm:h-9 sm:text-[14px]"
            />
          </label>

          <Field label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />

          <div className="flex flex-col gap-1 text-[12px]">
            <span className="font-medium text-muted-foreground">Received in</span>
            {/* No "credit" — an advance that was not actually received is not
                an advance. */}
            <ModePills value={mode} onChange={setMode} modes={["cash", "bank", "upi", "cheque"]} />
          </div>

          {mode === "bank" && (
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="font-medium text-muted-foreground">Account</span>
              <select
                value={bankId}
                onChange={(e) => setBankId(e.target.value)}
                className="h-11 rounded border bg-background px-3 text-[16px] outline-none focus:border-primary sm:h-9 sm:text-[14px]"
              >
                <option value="">— choose —</option>
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {/* Said plainly, because it is the part that surprises people: the
              money lands on the customer's account, not on this document. */}
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
            This is recorded as a receipt from {doc.partyName} — an advance on their account. A
            proforma is not a bill, so nothing is settled against it. When you raise the tax
            invoice, apply this advance to it from the Payments screen.
          </p>

          <div className="mt-1 flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Record"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
