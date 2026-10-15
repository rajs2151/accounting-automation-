"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  bboxOverlayStyle,
  filterBoxesForPage,
  type PageBBox,
} from "@/lib/review-bbox";
import { cn } from "@/lib/utils";

type Props = {
  /** Absolute or site-relative URL to PDF / image */
  fileUrl: string;
  boxes: PageBBox[];
  activeLabel: string | null;
  /** Display label for the active field chip, e.g. "Grand total". */
  activeChipLabel?: string | null;
  /** Display value for the active field chip, e.g. "105.00". */
  activeChipValue?: string | null;
  fieldStatus?: Record<string, { status?: string; confidence?: number }>;
  onSelectField?: (label: string) => void;
  /** Jump to this page when the focused field changes (1-based). */
  focusPage?: number | null;
  /** When true, zoom/scroll to the active bbox; when false/cleared, restore prior view. */
  focusBBox?: boolean;
  onPageMeta?: (meta: {
    pageCount: number;
    pageSizes: Record<number, { width: number; height: number }>;
  }) => void;
  className?: string;
};

type PdfDoc = {
  numPages: number;
  getPage: (n: number) => Promise<{
    getViewport: (opts: { scale: number }) => { width: number; height: number };
    render: (params: unknown) => { promise: Promise<void> };
  }>;
};

const FIT_WIDTH = 720;
const THUMB_SCALE = 0.18;

type ViewSnapshot = {
  page: number;
  zoom: number;
  fitMode: boolean;
  scrollLeft: number;
  scrollTop: number;
};

/**
 * Multi-page PDF / image preview with thumbnails, zoom, fit, and field highlights
 * from worker source page+bbox (PDF points, origin top-left).
 */
export function PdfPagePreview({
  fileUrl,
  boxes,
  activeLabel,
  activeChipLabel,
  activeChipValue,
  fieldStatus = {},
  onSelectField,
  focusPage,
  focusBBox = false,
  onPageMeta,
  className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState({ width: 595, height: 842 });
  const [renderSize, setRenderSize] = useState({ width: 595, height: 842 });
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState(true);
  const [error, setError] = useState("");
  const [thumbUrls, setThumbUrls] = useState<Record<number, string>>({});
  const savedViewRef = useRef<ViewSnapshot | null>(null);
  const focusingRef = useRef(false);
  const isImage = /\.(png|jpe?g|webp)(\?|$)/i.test(fileUrl);

  // Load PDF bytes once; do not render every page at full resolution.
  useEffect(() => {
    if (isImage) {
      setDoc(null);
      setPageCount(1);
      setCurrentPage(1);
      onPageMeta?.({ pageCount: 1, pageSizes: { 1: { width: 595, height: 842 } } });
      return;
    }
    let cancelled = false;
    const thumbs: Record<number, string> = {};
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const bytes = await fetch(fileUrl).then((r) => {
          if (!r.ok) throw new Error(`fetch_${r.status}`);
          return r.arrayBuffer();
        });
        const loaded = (await pdfjs.getDocument({ data: bytes }).promise) as unknown as PdfDoc;
        if (cancelled) return;
        setDoc(loaded);
        setPageCount(loaded.numPages);
        setCurrentPage(1);
        setError("");

        const pageSizes: Record<number, { width: number; height: number }> = {};
        for (let n = 1; n <= loaded.numPages; n++) {
          const page = await loaded.getPage(n);
          const base = page.getViewport({ scale: 1 });
          pageSizes[n] = { width: base.width, height: base.height };
          // Lazy-ish thumbnails: small scale only.
          const tv = page.getViewport({ scale: THUMB_SCALE });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(tv.width);
          canvas.height = Math.floor(tv.height);
          const ctx = canvas.getContext("2d");
          if (ctx) {
            await page.render({ canvasContext: ctx, viewport: tv, canvas } as Parameters<
              typeof page.render
            >[0]).promise;
            thumbs[n] = canvas.toDataURL("image/png");
          }
        }
        if (cancelled) return;
        setThumbUrls(thumbs);
        onPageMeta?.({ pageCount: loaded.numPages, pageSizes });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "pdf_render_failed");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileUrl, isImage]);

  // Jump to the focused field's page.
  useEffect(() => {
    if (focusPage != null && focusPage >= 1 && focusPage <= pageCount) {
      setCurrentPage(focusPage);
    }
  }, [focusPage, pageCount]);

  // Zoom/scroll to active bbox on focus; restore previous view on leave.
  useEffect(() => {
    if (!focusBBox || !activeLabel) {
      if (focusingRef.current && savedViewRef.current) {
        const snap = savedViewRef.current;
        setCurrentPage(snap.page);
        setZoom(snap.zoom);
        setFitMode(snap.fitMode);
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (el) {
            el.scrollLeft = snap.scrollLeft;
            el.scrollTop = snap.scrollTop;
          }
        });
        savedViewRef.current = null;
        focusingRef.current = false;
      }
      return;
    }

    const box = boxes.find((b) => b.label === activeLabel);
    if (!box) return;

    if (!focusingRef.current) {
      savedViewRef.current = {
        page: currentPage,
        zoom,
        fitMode,
        scrollLeft: scrollRef.current?.scrollLeft ?? 0,
        scrollTop: scrollRef.current?.scrollTop ?? 0,
      };
      focusingRef.current = true;
    }

    setCurrentPage(box.page);
    // Zoom so the box is comfortably visible (~40% of viewport width target).
    const boxW = Math.max(1, box.x1 - box.x0);
    const targetZoom = Math.min(2.5, Math.max(1.1, (FIT_WIDTH * 0.45) / boxW));
    setFitMode(false);
    setZoom(Math.round(targetZoom * 100) / 100);
  }, [focusBBox, activeLabel, boxes]); // eslint-disable-line react-hooks/exhaustive-deps

  // After zoom/render, scroll the active box into view.
  useEffect(() => {
    if (!focusBBox || !activeLabel || !focusingRef.current) return;
    const box = boxes.find((b) => b.label === activeLabel);
    if (!box || box.page !== currentPage) return;
    const el = scrollRef.current;
    if (!el) return;
    const scale = fitMode
      ? Math.min(1.4, FIT_WIDTH / pageSize.width) * zoom
      : Math.max(0.4, Math.min(3, zoom));
    const left = box.x0 * scale;
    const top = box.y0 * scale;
    const width = (box.x1 - box.x0) * scale;
    const height = (box.y1 - box.y0) * scale;
    const targetLeft = Math.max(0, left + width / 2 - el.clientWidth / 2);
    const targetTop = Math.max(0, top + height / 2 - el.clientHeight / 2);
    el.scrollTo({ left: targetLeft, top: targetTop, behavior: "smooth" });
  }, [focusBBox, activeLabel, boxes, currentPage, zoom, fitMode, pageSize.width, renderSize]);

  // Render only the current page at the active zoom / fit scale.
  useEffect(() => {
    if (isImage || !doc) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await doc.getPage(currentPage);
        const base = page.getViewport({ scale: 1 });
        const fitScale = Math.min(1.4, FIT_WIDTH / base.width);
        const scale = fitMode ? fitScale * zoom : Math.max(0.4, Math.min(3, zoom));
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
  }, [doc, currentPage, zoom, fitMode, isImage]);

  const pageBoxes = filterBoxesForPage(boxes, currentPage);
  const activeBox = activeLabel
    ? pageBoxes.find((b) => b.label === activeLabel)
    : undefined;
  const chipText =
    activeBox && (activeChipLabel || activeChipValue)
      ? `${activeChipLabel || activeLabel}: ${activeChipValue ?? ""}`.trim()
      : null;

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col rounded-lg border border-border bg-[#f7f4ef] p-3",
        className,
      )}
      data-testid="review-preview"
      ref={containerRef}
    >
      {!isImage ? (
        <div
          className="mb-2 flex shrink-0 flex-wrap items-center gap-2"
          data-testid="review-viewer-toolbar"
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="review-page-prev"
            disabled={currentPage <= 1}
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </Button>
          <span className="text-sm tabular-nums" data-testid="review-page-indicator">
            {currentPage} / {pageCount}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="review-page-next"
            disabled={currentPage >= pageCount}
            onClick={() => setCurrentPage((p) => Math.min(pageCount, p + 1))}
          >
            Next
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="review-zoom-out"
            onClick={() => {
              setFitMode(false);
              setZoom((z) => Math.max(0.4, Math.round((z - 0.25) * 100) / 100));
            }}
          >
            −
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="review-zoom-in"
            onClick={() => {
              setFitMode(false);
              setZoom((z) => Math.min(3, Math.round((z + 0.25) * 100) / 100));
            }}
          >
            +
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="review-zoom-fit"
            onClick={() => {
              setFitMode(true);
              setZoom(1);
            }}
          >
            Fit width
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="review-zoom-level">
            {fitMode ? "fit" : `${Math.round(zoom * 100)}%`}
          </span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        {!isImage && pageCount > 1 ? (
          <div
            className="flex max-h-full w-20 shrink-0 flex-col gap-2 overflow-y-auto"
            data-testid="review-page-thumbnails"
          >
            {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                data-testid={`review-thumb-${n}`}
                className={[
                  "overflow-hidden rounded border bg-white p-0.5",
                  n === currentPage ? "border-primary ring-1 ring-primary" : "border-border",
                ].join(" ")}
                onClick={() => setCurrentPage(n)}
              >
                {thumbUrls[n] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumbUrls[n]} alt={`Page ${n}`} className="block w-full" />
                ) : (
                  <span className="block py-6 text-center text-[10px] text-muted-foreground">{n}</span>
                )}
              </button>
            ))}
          </div>
        ) : null}

        <div
          className="min-h-0 min-w-0 flex-1 overflow-auto"
          ref={scrollRef}
          data-testid="review-preview-scroll"
        >
          <div
            className="relative mx-auto bg-white shadow-sm"
            style={
              isImage
                ? { width: "100%" }
                : { width: renderSize.width, height: renderSize.height, maxWidth: "100%" }
            }
            data-testid="review-page-surface"
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
                  onPageMeta?.({
                    pageCount: 1,
                    pageSizes: {
                      1: { width: img.naturalWidth, height: img.naturalHeight },
                    },
                  });
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
              {activeBox && chipText ? (
                <div
                  data-testid="source-highlight"
                  className="pointer-events-none absolute z-10 max-w-[220px] truncate rounded bg-emerald-700 px-1.5 py-0.5 text-[11px] font-medium text-white shadow-sm"
                  style={{
                    left: bboxOverlayStyle({
                      ...activeBox,
                      pageWidth: activeBox.pageWidth || pageSize.width,
                      pageHeight: activeBox.pageHeight || pageSize.height,
                    }).left,
                    top: `calc(${
                      bboxOverlayStyle({
                        ...activeBox,
                        pageWidth: activeBox.pageWidth || pageSize.width,
                        pageHeight: activeBox.pageHeight || pageSize.height,
                      }).top
                    } - 1.4rem)`,
                  }}
                >
                  {chipText}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
