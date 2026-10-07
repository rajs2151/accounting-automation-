"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useBooksShell } from "@/components/books/books-shell-context";
import { DocumentReviewPanels } from "@/components/books/document-review-panels";
import { Button } from "@/components/ui/button";

/** Full-page draft document review (ING-3). Posted docs stay on list drawers. */
export default function DocumentReviewPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { setSidebarCollapsed } = useBooksShell();
  const [docType, setDocType] = useState("");

  useEffect(() => {
    setSidebarCollapsed(true);
    return () => setSidebarCollapsed(false);
  }, [setSidebarCollapsed]);

  useEffect(() => {
    fetch(`/api/books/documents/${params.id}`)
      .then((r) => r.json())
      .then((d) => setDocType(String(d?.docType || "")))
      .catch(() => undefined);
  }, [params.id]);

  const backHref =
    docType.includes("purchase") || docType.includes("bill")
      ? "/books/purchases"
      : "/books/sales";

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link
            href={backHref}
            className="inline-flex h-8 items-center rounded-lg px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            ‹ Back
          </Link>
          <h1 className="text-lg font-semibold">Document review</h1>
        </div>
        <Button variant="outline" size="sm" onClick={() => router.push(backHref)}>
          Close
        </Button>
      </div>
      <DocumentReviewPanels
        documentId={params.id}
        onApproved={() => router.push(backHref)}
      />
    </div>
  );
}
