/**
 * One job card: printed the shop's way (Print / PDF / WhatsApp), its stage,
 * and the link to making it.
 *
 * Moving it to the "made" stage opens the production run already filled in
 * from the card — the BOM, the size, the pieces, the qty billed, the
 * customer — with the cutting plan shown before it is saved; saving marks the
 * card made (one batch, lib in productions.tsx). Moving it back undoes that
 * run, with the same guards as deleting it on the Production page.
 */
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { JobCardRepo, CompanyRepo, BomRepo, ItemRepo, ProductionRepo } from "@/repositories";
import { useRepoData, useRepoMemo } from "@/hooks/useRepoData";
import { usePermissions } from "@/hooks/usePermissions";
import { mtmOf } from "@/lib/mtm";
import { jobCardText } from "@/lib/jobCards";
import { consumptionForSize } from "@/lib/sizing";
import { planRunCuts } from "@/lib/productionCuts";
import { pieceDataFromRepos } from "@/lib/pieceData";
import { piecesLabel, fmtLen } from "@/lib/pieces";
import { printWithName, isStandalone } from "@/lib/print";
import { downloadElementAsPdf } from "@/lib/pdf";
import { JobCardPrint, type WorkshopLine } from "@/components/JobCardPrint";
import { ProductionDialog, deleteProductionRun } from "@/routes/productions";
import { JobCardDialog, setStage, stageMove } from "@/routes/job-cards";
import { Button } from "@/components/ui/button";
import { ClipboardList, Printer, Download, Send, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { JobCard } from "@/types";

export const Route = createFileRoute("/job-cards_/$id")({
  component: JobCardPage,
  validateSearch: (s: Record<string, unknown>): { go?: string } => ({
    go: typeof s.go === "string" ? s.go : undefined,
  }),
});

const fmtQty = (n: number) => String(Math.round(n * 100) / 100);

function JobCardPage() {
  useRepoData();
  const { id } = Route.useParams();
  const { go } = Route.useSearch();
  const navigate = useNavigate();
  const { isOwner, canEdit, canDelete } = usePermissions();
  const editAllowed = isOwner || canEdit("masterData");
  const deleteAllowed = isOwner || canDelete("masterData");
  const card = useRepoMemo(() => JobCardRepo.get(id), [id]);
  const m = mtmOf(CompanyRepo.get());
  const [makeOpen, setMakeOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [withWork, setWithWork] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const printRef = useRef<HTMLDivElement>(null);
  const handledGo = useRef<string | undefined>(undefined);

  // A stage chosen on the list that needs this page (make / undo).
  useEffect(() => {
    if (!card || !go || handledGo.current === go) return;
    handledGo.current = go;
    navigate({ to: "/job-cards/$id", params: { id }, search: {} as never, replace: true });
    void moveTo(card, go);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card, go]);

  if (!card)
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        This job card no longer exists.
      </div>
    );

  const bom = card.bomId ? BomRepo.get(card.bomId) : undefined;
  const production = card.productionId ? ProductionRepo.get(card.productionId) : undefined;

  // For the workshop: what this size takes, and which pieces to cut.
  const workshop = (() => {
    if (!withWork || !bom?.sizing) return null;
    const items = ItemRepo.all();
    const byId = new Map(items.map((i) => [i.id, i] as const));
    const size = { ...card.size, pieces: card.pieces };
    const r = consumptionForSize(bom, size, card.pieces, byId, {
      constants: m.constants,
      roundUpWhole: true,
    });
    const plans = production?.cuts
      ? production.cuts.map((c) => ({
          itemId: c.itemId,
          cuts: c.cuts,
          taken: c.taken,
          returned: c.returned,
        }))
      : planRunCuts(bom, size, card.pieces, items, pieceDataFromRepos(), {
          constants: m.constants,
        }).map((x) => ({
          itemId: x.itemId,
          cuts: x.plan.cuts,
          taken: x.plan.taken,
          returned: x.plan.returned,
        }));
    const cutItems = new Set(plans.map((p) => p.itemId));
    const materials: WorkshopLine[] = r.lines
      .filter((l) => !cutItems.has(l.itemId))
      .map((l) => ({ name: l.itemName, qty: `${fmtQty(l.qty)} ${l.unit}` }));
    const cuts: WorkshopLine[] = plans.map((p) => {
      const it = byId.get(p.itemId);
      const u = it?.unit ?? "";
      return {
        name: `${it?.name ?? "material"}: cut ${piecesLabel(p.cuts, u)}`,
        qty: `from ${p.taken.length ? piecesLabel(p.taken, u) : "unsorted"}${p.returned.length ? `; keep ${piecesLabel(p.returned, u)}` : ""}`,
      };
    });
    return { materials, cuts };
  })();

  async function moveTo(c: JobCard, target: string) {
    if (!editAllowed) return void toast.error("You don't have permission to change job cards");
    const move = stageMove(c, target);
    if (move === "plain") return setStage(c, target);
    if (move === "make") {
      if (!c.bomId || !BomRepo.get(c.bomId)) {
        toast.error(
          "This card's item has no made-to-measure BOM — record the production on the Production page",
        );
        return;
      }
      setMakeOpen(true);
      return;
    }
    // Undo: the run goes (same guards as the Production page), the card
    // moves back to the stage before "made" — then to where it was asked.
    const run = c.productionId ? ProductionRepo.get(c.productionId) : undefined;
    if (!run) {
      JobCardRepo.update(c.id, { productionId: null });
      return setStage({ ...c, productionId: null }, target);
    }
    const ok = await deleteProductionRun(run, { deleteAllowed });
    if (ok) {
      const after = JobCardRepo.get(c.id);
      if (after && after.stage !== target) setStage(after, target);
    }
  }

  const doPrint = async () => {
    if (isStandalone()) return doPdf();
    printWithName(card.number);
  };
  const doPdf = async () => {
    if (!printRef.current || busy) return;
    setBusy("pdf");
    try {
      await downloadElementAsPdf(printRef.current, card.number, "portrait");
      toast.success("Job card downloaded");
    } catch {
      toast.error("Could not make the PDF — try Print instead");
    } finally {
      setBusy(null);
    }
  };
  const doWhatsApp = () => {
    // The karigar picks the chat; the card goes as text (PDF to attach too).
    const text = jobCardText(card, CompanyRepo.get().name || "M Décor");
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  };
  const remove = async () => {
    if (!deleteAllowed) return void toast.error("You don't have permission to delete job cards");
    if (card.productionId && ProductionRepo.get(card.productionId))
      return void toast.error(
        `Undo the production first — move ${card.number} back from "${m.completeStage}"`,
      );
    if (!confirm(`Delete job card ${card.number}?`)) return;
    JobCardRepo.remove(card.id);
    toast.success(`${card.number} deleted`);
    navigate({ to: "/job-cards" });
  };

  const stageIdx = m.jobStages.indexOf(card.stage);
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={`Job ${card.number}`}
        subtitle={`${card.partyName} · ${card.finishedItemName}`}
        icon={<ClipboardList className="h-5 w-5" />}
        showBack
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={doPrint} disabled={!!busy}>
              <Printer className="h-4 w-4" /> Print
            </Button>
            <Button variant="outline" onClick={doPdf} disabled={!!busy}>
              <Download className="h-4 w-4" /> {busy === "pdf" ? "…" : "PDF"}
            </Button>
            <Button variant="outline" onClick={doWhatsApp}>
              <Send className="h-4 w-4" /> WhatsApp
            </Button>
            {editAllowed && (
              <Button variant="outline" onClick={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
            )}
            {deleteAllowed && (
              <Button variant="outline" onClick={remove} title="Delete job card">
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        }
      />
      <div className="flex-1 overflow-auto bg-muted/30 p-4 sm:p-5">
        <div className="mx-auto max-w-[720px] flex flex-col gap-3">
          <div className="rounded-md border bg-card p-3 shadow-card flex flex-col gap-2">
            <p className="text-[12px] font-semibold text-muted-foreground">Stage</p>
            <div className="flex flex-wrap gap-1.5" aria-label="Job stage">
              {m.jobStages.map((s, i) => (
                <button
                  key={s}
                  onClick={() => void moveTo(card, s)}
                  disabled={!editAllowed || s === card.stage}
                  aria-pressed={s === card.stage}
                  className={`h-8 px-3 rounded-full text-[12.5px] font-semibold border ${
                    s === card.stage
                      ? "bg-primary text-primary-foreground border-primary"
                      : i < stageIdx
                        ? "bg-emerald-50 border-emerald-300 text-emerald-800"
                        : "bg-background hover:bg-accent"
                  }`}
                >
                  {s}
                  {s === m.completeStage ? " ✓ (makes it)" : ""}
                </button>
              ))}
            </div>
            <div className="text-[12px] text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
              {card.sourceId && card.sourceKind && card.sourceKind !== "sale" && (
                <Link
                  to={card.sourceKind === "quotation" ? "/quotations/$id" : "/proforma/$id"}
                  params={{ id: card.sourceId }}
                  className="text-primary hover:underline"
                >
                  Order {card.sourceNumber}
                </Link>
              )}
              {production ? (
                <Link
                  to="/productions"
                  search={{ open: production.id } as never}
                  className="text-emerald-700 hover:underline"
                >
                  Made — {production.number} ({fmtLen(production.qty)} {production.unit})
                </Link>
              ) : (
                <span>Not made yet — moving it to "{m.completeStage}" records the production</span>
              )}
              {card.assignedTo && <span>Karigar: {card.assignedTo}</span>}
            </div>
            {bom?.sizing && (
              <label className="flex items-center gap-2 text-[12.5px]">
                <input
                  type="checkbox"
                  checked={withWork}
                  onChange={(e) => setWithWork(e.target.checked)}
                  aria-label="Include materials and cut list"
                />
                Print the materials &amp; cut list for the workshop too
              </label>
            )}
          </div>
          <div className="bg-white shadow-card">
            <div ref={printRef} className="print-visible">
              <JobCardPrint
                card={card}
                company={{ name: CompanyRepo.get().name || "M Décor" }}
                workshop={workshop}
              />
            </div>
          </div>
        </div>
      </div>
      <ProductionDialog
        open={makeOpen}
        onOpenChange={setMakeOpen}
        production={null}
        prefill={{
          bomId: card.bomId,
          finishedItemId: card.finishedItemId,
          size: { ...card.size, pieces: card.pieces },
          qty: card.qty,
          partyName: card.partyName,
          orderRef: [card.number, card.sourceNumber].filter(Boolean).join(" · "),
          notes: card.note,
          jobCardId: card.id,
        }}
      />
      <JobCardDialog open={editOpen} onOpenChange={setEditOpen} card={card} />
    </div>
  );
}
