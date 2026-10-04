"use client";

import { useEffect, useRef, useState } from "react";

import { bboxOverlayStyle, type PageBBox } from "@/lib/review-bbox";

type Props = {
  /** Absolute or site-relative URL to PDF / image */
  fileUrl: string;
  boxes: PageBBox[];
  activeLabel: string | null;
  fieldStatus?: Record<string, { status?: string; confidence?: number }>;
  onSelectField?: (label: string) => void;
};

/**
 * Renders the actual uploaded PDF (pdf.js) or image, with bbox overlays in the
 * same page coordinate space (origin top-left, pageWidth × pageHeight).
 */
export function PdfPagePreview({
  fileUrl,
  boxes,
  activeLabel,
  fieldStatus = {},
  onSelectField,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pageSize, setPageSize] = useState({ width: 595, height: 842 });
  const [renderSize, setRenderSize] = useState({ width: 595, height: 842 });
  const [error, setError] = useState("");
  const isImage = /\.(png|jpe?g|webp)$/i.test(fileUrl);

  useEffect(() => {
    if (isImage) return;
    let cancelled = false;
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const bytes = await fetch(fileUrl).then((r) => {
          if (!r.ok) throw new Error(`fetch_${r.status}`);
          return r.arrayBuffer();
        });
        const doc = await pdfjs.getDocument({ data: bytes }).promise;
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(1.4, 720 / base.width);
        const viewport = page.getViewport({ scale });
        if (cancelled) return;
        setPageSize({ width: base.width, height: base.height });
        setRenderSize({ width: viewport.width, height: viewport.height });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        // pdfjs ≥4 prefers canvas on the render params
        await page.render({ canvasContext: ctx, viewport, canvas } as Parameters<
          typeof page.render
        >[0]).promise;
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "pdf_render_failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileUrl, isImage]);

  const pageBoxes = boxes.filter((b) => b.page === 1);

  return (
    <div
      className="relative overflow-auto rounded-lg border border-border bg-[#f7f4ef] p-3"
      data-testid="review-preview"
    >
      <div
        className="relative mx-auto bg-white shadow-sm"
        style={
          isImage
            ? { width: "100%" }
            : { width: renderSize.width, height: renderSize.height, maxWidth: "100%" }
        }
      >
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={fileUrl}
            alt="Document"
            className="block w-full"
            data-testid="review-file-image"
            onLoad={(e) => {
              const img = e.currentTarget;
              setPageSize({ width: img.naturalWidth, height: img.naturalHeight });
              setRenderSize({ width: img.clientWidth, height: img.clientHeight });
            }}
          />
        ) : (
          <canvas
            ref={canvasRef}
            className="block h-full w-full"
            data-testid="review-file-pdf"
          />
        )}
        <div className="pointer-events-none absolute inset-0">
          {pageBoxes.map((b) => {
            const meta = fieldStatus[b.label] || {};
            const bad = meta.status === "fail";
            const low = (meta.confidence ?? 1) < 0.8;
            const active = activeLabel === b.label;
            const style = bboxOverlayStyle({
              ...b,
              pageWidth: b.pageWidth || pageSize.width,
              pageHeight: b.pageHeight || pageSize.height,
            });
            return (
              <button
                key={b.label}
                type="button"
                data-testid={`bbox-${b.label}`}
                className={[
                  "pointer-events-auto absolute border-2",
                  bad
                    ? "border-red-500 bg-red-400/25"
                    : low
                      ? "border-amber-500 bg-amber-400/25"
                      : "border-sky-500 bg-sky-400/20",
                  active ? "ring-2 ring-offset-1 ring-stone-800" : "",
                ].join(" ")}
                style={style}
                onClick={() => onSelectField?.(b.label)}
                title={b.label}
              />
            );
          })}
        </div>
      </div>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
