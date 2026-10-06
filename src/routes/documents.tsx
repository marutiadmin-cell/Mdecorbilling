import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { BusinessDocRepo } from "@/repositories";
import { genId } from "@/repositories/base";
import { useRepoData } from "@/hooks/useRepoData";
import { useStickyState } from "@/hooks/useStickySearch";
import { useAutoFocusOnDesktop } from "@/hooks/use-mobile";
import { usePermissions } from "@/hooks/usePermissions";
import type { BusinessDoc } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/Field";
import { fmtDate } from "@/lib/format";
import {
  MAX_DOC_BYTES,
  prettySize,
  suggestedName,
  validateUpload,
  storagePathFor,
  docMatches,
} from "@/lib/businessDocs";
import { uploadDoc, docDownloadUrl, deleteDoc } from "@/lib/docStorage";
import { Search, Upload, Download, Pencil, Trash2, FileText, FolderOpen } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/documents")({ component: DocumentsPage });

function DocumentsPage() {
  const _v = useRepoData();
  const searchRef = useRef<HTMLInputElement>(null);
  useAutoFocusOnDesktop(searchRef);
  const { isOwner, canEdit, canDelete } = usePermissions();
  const editAllowed = isOwner || canEdit("documents");
  const deleteAllowed = isOwner || canDelete("documents");

  const [rows, setRows] = useState<BusinessDoc[]>([]);
  const [q, setQ] = useStickyState("documents.search", "");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [renaming, setRenaming] = useState<BusinessDoc | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setRows(
      BusinessDocRepo.all()
        .slice()
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
    );
  }, [_v]);

  const shown = rows.filter((d) => docMatches(q, d));

  /* Opened in a new tab rather than fetched and re-served: Storage's own URL
     already carries the file name and the right content type, and routing the
     bytes through here would only make a 20MB drawing arrive twice. */
  const open = async (doc: BusinessDoc) => {
    setBusy(doc.id);
    try {
      const url = await docDownloadUrl(doc.storagePath);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open this document");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (doc: BusinessDoc) => {
    if (!confirm(`Delete "${doc.name}"? The file is removed too and cannot be recovered.`)) return;
    setBusy(doc.id);
    try {
      /* File first. If the record went first and this failed, the shop would
         be paying to store a file nothing in the app can reach or name. */
      await deleteDoc(doc.storagePath);
      BusinessDocRepo.remove(doc.id);
      toast.success(`"${doc.name}" deleted`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete this document");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Documents"
        subtitle={`${rows.length} saved`}
        icon={<FolderOpen className="h-5 w-5" />}
        actions={
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <div className="relative flex-1 sm:flex-none">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <input
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search documents…"
                className="h-9 w-full sm:w-64 pl-8 pr-3 rounded-md border bg-background outline-none focus:border-primary focus:ring-2 focus:ring-ring/20"
              />
            </div>
            {editAllowed && (
              <Button onClick={() => setUploadOpen(true)} className="shrink-0">
                <Upload className="h-4 w-4" /> Upload
              </Button>
            )}
          </div>
        }
      />

      <div className="flex-1 overflow-auto p-4 sm:p-5">
        {shown.length === 0 ? (
          <div className="mx-auto max-w-md rounded-lg border bg-card px-6 py-12 text-center shadow-card">
            <FolderOpen className="mx-auto h-10 w-10 text-muted-foreground/40" />
            <p className="mt-3 text-[15px] font-semibold">
              {rows.length === 0 ? "No documents yet" : "Nothing matches that"}
            </p>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {rows.length === 0
                ? "Keep the business's paperwork here — GST certificate, PAN, licences, insurance, signed contracts — and it is one tap away wherever you are."
                : "Try a different word, or clear the search."}
            </p>
            {rows.length === 0 && editAllowed && (
              <Button className="mt-5" onClick={() => setUploadOpen(true)}>
                <Upload className="h-4 w-4" /> Upload the first one
              </Button>
            )}
          </div>
        ) : (
          <div className="rounded-lg border bg-card shadow-card overflow-hidden">
            {shown.map((doc) => (
              <div
                key={doc.id}
                className="flex flex-col gap-3 border-b px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary">
                    <FileText className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-semibold">{doc.name}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {doc.fileName} · {prettySize(doc.size)} · {fmtDate(doc.createdAt)}
                      {doc.createdBy ? ` · ${doc.createdBy}` : ""}
                    </p>
                    {!!doc.note && (
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {doc.note}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === doc.id}
                    onClick={() => open(doc)}
                  >
                    <Download className="h-4 w-4" /> {busy === doc.id ? "Opening…" : "Download"}
                  </Button>
                  {editAllowed && (
                    <Button variant="outline" size="sm" onClick={() => setRenaming(doc)}>
                      <Pencil className="h-4 w-4" /> Rename
                    </Button>
                  )}
                  {deleteAllowed && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy === doc.id}
                      onClick={() => remove(doc)}
                      className="text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        existingNames={rows.map((d) => d.name)}
      />
      <RenameDialog doc={renaming} onDone={() => setRenaming(null)} />
    </div>
  );
}

function UploadDialog({
  open,
  onOpenChange,
  existingNames,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  existingNames: string[];
}) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setName("");
      setNote("");
      setSaving(false);
    }
  }, [open]);

  const save = async () => {
    const check = validateUpload(file, name, existingNames);
    if (!check.ok) {
      toast.error(check.message);
      return;
    }
    if (!file) return;
    setSaving(true);
    const id = genId();
    const storagePath = storagePathFor(id, file.name);
    try {
      /* The file goes up BEFORE the record is written. The other order gives
         the shop a row that opens nothing, which is worse than an upload that
         visibly failed and can be repeated. */
      await uploadDoc(storagePath, file);
      BusinessDocRepo.add({
        id,
        name: name.trim(),
        fileName: file.name,
        contentType: file.type || undefined,
        size: file.size,
        storagePath,
        note: note.trim() || undefined,
      } as BusinessDoc);
      toast.success(`"${name.trim()}" saved`);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not upload this document");
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Upload a document</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="font-medium text-muted-foreground">File *</span>
            <input
              type="file"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                // Only fills a name the person has not typed themselves.
                if (f && !name.trim()) setName(suggestedName(f.name));
              }}
              className="h-11 w-full rounded border bg-background px-3 py-2 text-[13px] file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-[12px] file:font-semibold sm:h-auto"
            />
            <span className="text-muted-foreground">
              Anything up to {prettySize(MAX_DOC_BYTES)} — a PDF, a photo of a certificate, a
              drawing.
            </span>
          </label>

          <Field
            label="Name it *"
            value={name}
            placeholder="GST Certificate"
            onChange={(e) => setName(e.target.value)}
          />
          <Field
            label="Note (optional)"
            value={note}
            placeholder="Renewed Sept 2026"
            onChange={(e) => setNote(e.target.value)}
          />

          <div className="mt-1 flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Uploading…" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({ doc, onDone }: { doc: BusinessDoc | null; onDone: () => void }) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    setName(doc?.name ?? "");
    setNote(doc?.note ?? "");
  }, [doc]);

  const save = () => {
    if (!doc) return;
    const next = name.trim();
    if (!next) {
      toast.error("Give this document a name you'll recognise.");
      return;
    }
    const clash = BusinessDocRepo.all().find(
      (d) => d.id !== doc.id && d.name.trim().toLowerCase() === next.toLowerCase(),
    );
    if (clash) {
      toast.error(`"${clash.name}" is already saved under that name.`);
      return;
    }
    // Only the record changes — the file's path never mentioned the name.
    BusinessDocRepo.update(doc.id, { name: next, note: note.trim() || undefined });
    toast.success("Renamed");
    onDone();
  };

  return (
    <Dialog open={!!doc} onOpenChange={(v) => !v && onDone()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Rename document</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field label="Name *" value={name} onChange={(e) => setName(e.target.value)} />
          <Field label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
          <p className="text-[11px] text-muted-foreground">
            The file itself is untouched — it keeps its own name, {doc?.fileName}.
          </p>
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="outline" onClick={onDone}>
              Cancel
            </Button>
            <Button onClick={save}>Save</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
