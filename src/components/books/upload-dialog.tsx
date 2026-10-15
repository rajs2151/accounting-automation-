"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileUp, Minimize2, X } from "lucide-react";
import { toast } from "sonner";

import { showUploadFeedback } from "@/components/books/upload-feedback";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api-error";
import {
  BOOKS_UPLOAD_ACCEPT,
  BOOKS_UPLOAD_MAX_BYTES,
  assertBooksUploadAllowed,
} from "@/lib/books-upload";
import { cn } from "@/lib/utils";

export type UploadDocType =
  | ""
  | "sales_invoice"
  | "purchase_bill"
  | "receipt"
  | "bank_statement"
  | "card_statement";

type FileRow = {
  id: string;
  file: File;
  progress: number;
  status: "queued" | "uploading" | "done" | "rejected" | "duplicate";
  reason?: string;
  inboxItemId?: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Default intended type when the dialog opens (e.g. purchases → purchase_bill). */
  defaultDocType?: UploadDocType;
  /** Banking upload can bind an intended account. */
  intendedAccountId?: string | null;
  onUploaded?: () => void;
};

function xhrUpload(
  file: File,
  fields: Record<string, string>,
  onProgress: (pct: number) => void,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/books/inbox/upload");
    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      onProgress(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onload = () => {
      let data: unknown = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        data = {};
      }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, data: { error: "network_error" } });
    const body = new FormData();
    body.append("files", file);
    for (const [k, v] of Object.entries(fields)) {
      if (v) body.append(k, v);
    }
    xhr.send(body);
  });
}

export function UploadDialog({
  open,
  onOpenChange,
  defaultDocType = "",
  intendedAccountId,
  onUploaded,
}: Props) {
  const [docType, setDocType] = useState<UploadDocType>(defaultDocType);
  const [rows, setRows] = useState<FileRow[]>([]);
  const [minimized, setMinimized] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pumpingRef = useRef(false);
  const docTypeRef = useRef(docType);
  const accountRef = useRef(intendedAccountId);
  const onUploadedRef = useRef(onUploaded);
  const busy = rows.some((r) => r.status === "uploading" || r.status === "queued");

  useEffect(() => {
    docTypeRef.current = docType;
  }, [docType]);
  useEffect(() => {
    accountRef.current = intendedAccountId;
  }, [intendedAccountId]);
  useEffect(() => {
    onUploadedRef.current = onUploaded;
  }, [onUploaded]);

  useEffect(() => {
    if (open) {
      setDocType(defaultDocType);
      setMinimized(false);
    }
  }, [open, defaultDocType]);

  const enqueue = useCallback((files: FileList | File[]) => {
    const next: FileRow[] = [];
    for (const file of Array.from(files)) {
      try {
        assertBooksUploadAllowed(file.name, file.size);
        next.push({
          id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
          file,
          progress: 0,
          status: "queued",
        });
      } catch (e) {
        next.push({
          id: `${file.name}-rej-${Math.random()}`,
          file,
          progress: 0,
          status: "rejected",
          reason: e instanceof Error ? e.message : "rejected",
        });
      }
    }
    if (next.length) setRows((prev) => [...prev, ...next]);
  }, []);

  const queuedCount = rows.filter((r) => r.status === "queued").length;

  // Pump queued files sequentially. Avoid cancelling mid-XHR when row status updates.
  useEffect(() => {
    if (pumpingRef.current || queuedCount === 0) return;
    pumpingRef.current = true;
    (async () => {
      while (true) {
        const pending = await new Promise<FileRow | null>((resolve) => {
          setRows((prev) => {
            const next = prev.find((r) => r.status === "queued") || null;
            resolve(next);
            if (!next) return prev;
            return prev.map((r) =>
              r.id === next.id ? { ...r, status: "uploading" as const, progress: 0 } : r,
            );
          });
        });
        if (!pending) break;
        const rowId = pending.id;
        const fields: Record<string, string> = {};
        const type = docTypeRef.current;
        if (type) {
          fields.intendedType = type;
          if (type === "bank_statement" || type === "card_statement") {
            fields.userDocType = type;
          }
        }
        if (accountRef.current) fields.accountId = accountRef.current;
        const { ok, data } = await xhrUpload(pending.file, fields, (pct) => {
          setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, progress: pct } : r)));
        });
        if (!ok) {
          setRows((prev) =>
            prev.map((r) =>
              r.id === rowId
                ? {
                    ...r,
                    status: "rejected",
                    progress: 100,
                    reason: apiErrorMessage(data, "Upload failed"),
                  }
                : r,
            ),
          );
          toast.error(apiErrorMessage(data, "Upload failed"));
        } else {
          const results = (data as { results?: Array<{ inboxItemId: string; duplicate: boolean }> })
            ?.results;
          const first = results?.[0];
          showUploadFeedback(true, data);
          setRows((prev) =>
            prev.map((r) =>
              r.id === rowId
                ? {
                    ...r,
                    status: first?.duplicate ? "duplicate" : "done",
                    progress: 100,
                    inboxItemId: first?.inboxItemId,
                    reason: first?.duplicate ? "Already uploaded" : undefined,
                  }
                : r,
            ),
          );
          onUploadedRef.current?.();
        }
      }
      pumpingRef.current = false;
    })();
  }, [queuedCount]);

  const mb = Math.round(BOOKS_UPLOAD_MAX_BYTES / (1024 * 1024));

  if (minimized && (open || busy)) {
    return (
      <div
        className="fixed bottom-4 end-4 z-50 w-80 rounded-lg border border-border bg-background shadow-lg"
        data-testid="upload-tray"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-medium">Uploads</span>
          <div className="flex gap-1">
            <Button type="button" size="sm" variant="ghost" onClick={() => setMinimized(false)}>
              Expand
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                if (!busy) {
                  setRows([]);
                  onOpenChange(false);
                }
              }}
              aria-label="Close upload tray"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
        <ul className="max-h-48 space-y-2 overflow-y-auto p-3 text-xs">
          {rows.map((r) => (
            <li key={r.id}>
              <div className="flex justify-between gap-2">
                <span className="truncate">{r.file.name}</span>
                <span className="text-muted-foreground">{r.status}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${r.progress}%` }} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <Dialog
      open={open && !minimized}
      onOpenChange={(v) => {
        if (!v && busy) {
          setMinimized(true);
          return;
        }
        if (!v) setRows([]);
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-lg" data-testid="upload-dialog">
        <DialogHeader>
          <DialogTitle>Upload documents</DialogTitle>
          <DialogDescription>
            PDF, PNG, JPG, HEIC, XLSX/XLS, CSV — up to {mb} MB each. Multiple files allowed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs">Document type (optional)</Label>
            <Select
              value={docType || "auto"}
              onValueChange={(v) => setDocType(v === "auto" ? "" : (v as UploadDocType))}
            >
              <SelectTrigger className="mt-1 w-full" data-testid="upload-doc-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto-detect</SelectItem>
                <SelectItem value="sales_invoice">Sales invoice</SelectItem>
                <SelectItem value="purchase_bill">Purchase bill</SelectItem>
                <SelectItem value="receipt">Receipt</SelectItem>
                <SelectItem value="bank_statement">Bank statement</SelectItem>
                <SelectItem value="card_statement">Card statement</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div
            className={cn(
              "flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border px-4 py-8 text-center",
              dragging && "border-primary bg-muted/40",
            )}
            data-testid="upload-dropzone"
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer.files?.length) enqueue(e.dataTransfer.files);
            }}
            onClick={() => inputRef.current?.click()}
          >
            <FileUp className="mb-2 size-8 text-muted-foreground" />
            <p className="text-sm font-medium">Drag & drop or browse</p>
            <p className="mt-1 text-xs text-muted-foreground">Accepted: {BOOKS_UPLOAD_ACCEPT}</p>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={BOOKS_UPLOAD_ACCEPT}
              className="hidden"
              data-testid="upload-dialog-input"
              onChange={(e) => {
                if (e.target.files?.length) enqueue(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          <button
            type="button"
            className="text-start text-xs text-primary underline-offset-2 hover:underline"
            data-testid="upload-bank-sample"
            onClick={() => {
              const a = document.createElement("a");
              a.href = "/samples/bank-statement-sample.csv";
              a.download = "bank-statement-sample.csv";
              a.click();
            }}
          >
            Download sample bank CSV template
          </button>

          {rows.length ? (
            <ul className="max-h-48 space-y-2 overflow-y-auto text-sm" data-testid="upload-file-list">
              {rows.map((r) => (
                <li key={r.id} className="rounded-md border border-border px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{r.file.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {r.status === "rejected" || r.status === "duplicate"
                        ? r.reason || r.status
                        : r.status === "done"
                          ? "Uploaded"
                          : `${r.progress}%`}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted">
                    <div
                      className={cn(
                        "h-full transition-all",
                        r.status === "rejected" ? "bg-destructive" : "bg-primary",
                      )}
                      style={{ width: `${r.progress}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex justify-end gap-2">
            {busy ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMinimized(true)}
                data-testid="upload-minimize"
              >
                <Minimize2 className="me-1 size-3.5" />
                Minimize
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                if (!busy) {
                  setRows([]);
                  onOpenChange(false);
                } else setMinimized(true);
              }}
            >
              {busy ? "Hide" : "Done"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
