"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { PdfPagePreview } from "@/components/books/pdf-page-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMinor } from "@/lib/money";
import { invoiceSyn001DemoBboxes, type PageBBox } from "@/lib/review-bbox";
import { validateInvoiceLineSum } from "@/lib/invoice-validation";

type FieldState = {
  value: string;
  confidence: number;
  status?: string;
  bbox?: PageBBox;
};

const LABELS: Record<string, string> = {
  doc_type: "Document type",
  company_match: "Company match",
  supplier_name: "Supplier",
  customer_name: "Customer",
  supplier_trn: "Supplier TRN",
  customer_trn: "Customer TRN",
  invoice_no: "Invoice no",
  invoice_date: "Invoice date",
  due_date: "Due date",
  currency: "Currency",
  subtotal: "Subtotal",
  vat_total: "VAT",
  grand_total: "Grand total",
};

function buildDemoExtraction() {
  const boxes = invoiceSyn001DemoBboxes();
  const lines = [{ netMinor: 10000, vatMinor: 500 }];
  const grandTotalMinor = 10500;
  const validation = validateInvoiceLineSum({ lines, grandTotalMinor });

  const fields: Record<string, FieldState> = {
    doc_type: { value: "Sales invoice", confidence: 0.97, status: "ok" },
    company_match: {
      value: "Desert Falcon Services FZE (TRN match)",
      confidence: 0.94,
      status: "ok",
    },
    supplier_name: {
      value: "Desert Falcon Services FZE",
      confidence: 0.42,
      status: "low",
      bbox: boxes.supplier_name,
    },
    customer_name: {
      value: "Oasis Retail LLC",
      confidence: 0.91,
      status: "ok",
      bbox: boxes.customer_name,
    },
    supplier_trn: {
      value: "100000000000001",
      confidence: 0.95,
      status: "ok",
      bbox: boxes.supplier_trn,
    },
    customer_trn: {
      value: "100123456700003",
      confidence: 0.93,
      status: "ok",
      bbox: boxes.customer_trn,
    },
    invoice_no: {
      value: "INV-SYN-001",
      confidence: 0.98,
      status: "ok",
      bbox: boxes.invoice_no,
    },
    invoice_date: {
      value: "15/05/2026",
      confidence: 0.96,
      status: "ok",
      bbox: boxes.invoice_date,
    },
    due_date: { value: "14/06/2026", confidence: 0.88, status: "ok" },
    currency: { value: "AED", confidence: 0.99, status: "ok" },
    subtotal: {
      value: formatMinor(validation.subtotalMinor),
      confidence: 0.97,
      status: validation.fieldStatus.subtotal,
    },
    vat_total: {
      value: formatMinor(validation.vatTotalMinor),
      confidence: 0.97,
      status: "ok",
    },
    grand_total: {
      value: formatMinor(grandTotalMinor),
      confidence: 0.97,
      status: validation.fieldStatus.grand_total,
      bbox: boxes.grand_total,
    },
  };

  return {
    // Raster of the real invoice PDF (same fixture) — pdf.js canvas is flaky in
    // the standalone e2e build; image keeps boxes in the same coordinate space.
    fileUrl: "/books-demo/invoice-syn-001.png",
    validation_flags: validation.flags,
    line_items: [
      {
        description: "Consulting services",
        vatCode: "SR",
        netMinor: 10000,
        vatMinor: 500,
      },
    ],
    fields_json: fields,
  };
}

/** Split-view review: real PDF + bbox highlights ↔ human-labelled form. */
export default function InboxReviewPage() {
  const params = useParams<{ id: string }>();
  const demo = useMemo(() => buildDemoExtraction(), []);
  const [fields, setFields] = useState(demo.fields_json);
  const [activeField, setActiveField] = useState<string | null>("invoice_no");

  const boxes = Object.values(fields)
    .map((f) => f.bbox)
    .filter(Boolean) as PageBBox[];

  const fieldStatus = Object.fromEntries(
    Object.entries(fields).map(([k, f]) => [k, { status: f.status, confidence: f.confidence }]),
  );

  // Re-validate when grand total / lines change (demo: grand_total edit)
  function onFieldChange(key: string, value: string) {
    setFields((prev) => {
      const next = { ...prev, [key]: { ...prev[key], value } };
      if (key === "grand_total" || key === "subtotal" || key === "vat_total") {
        const subtotal =
          Math.round(parseFloat(next.subtotal.value.replace(/,/g, "")) * 100) || 10000;
        const vat = Math.round(parseFloat(next.vat_total.value.replace(/,/g, "")) * 100) || 500;
        const grand =
          Math.round(parseFloat(next.grand_total.value.replace(/,/g, "")) * 100) || 0;
        const v = validateInvoiceLineSum({
          lines: [{ netMinor: subtotal, vatMinor: vat }],
          grandTotalMinor: grand,
        });
        next.grand_total = {
          ...next.grand_total,
          status: v.fieldStatus.grand_total,
        };
      }
      return next;
    });
  }

  const flags = (() => {
    const subtotal =
      Math.round(parseFloat(fields.subtotal.value.replace(/,/g, "")) * 100) || 0;
    const vat = Math.round(parseFloat(fields.vat_total.value.replace(/,/g, "")) * 100) || 0;
    const grand =
      Math.round(parseFloat(fields.grand_total.value.replace(/,/g, "")) * 100) || 0;
    return validateInvoiceLineSum({
      lines: [{ netMinor: subtotal, vatMinor: vat }],
      grandTotalMinor: grand,
    }).flags;
  })();

  return (
    <div className="space-y-4 py-4" data-testid="review-split-view">
      <h1 className="text-2xl font-semibold">Review extraction</h1>
      {flags.length ? (
        <p className="text-sm text-red-600" data-testid="validation-flags">
          Flags: {flags.join(", ")}
        </p>
      ) : (
        <p className="text-sm text-emerald-700" data-testid="validation-flags">
          Amounts balanced (subtotal + VAT = grand total)
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <PdfPagePreview
            fileUrl={demo.fileUrl}
            boxes={boxes}
            activeLabel={activeField}
            fieldStatus={fieldStatus}
            onSelectField={setActiveField}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            File: invoice-syn-001.pdf (page raster) · Inbox item: {params.id}
          </p>
        </div>
        <div className="space-y-3 rounded-lg border border-border p-4">
          {(
            [
              "doc_type",
              "company_match",
              "supplier_name",
              "customer_name",
              "supplier_trn",
              "customer_trn",
              "invoice_no",
              "invoice_date",
              "due_date",
              "currency",
              "subtotal",
              "vat_total",
              "grand_total",
            ] as const
          ).map((key) => {
            const field = fields[key];
            if (!field) return null;
            const low = (field.confidence ?? 1) < 0.8;
            const bad = field.status === "fail";
            return (
              <div key={key}>
                <Label className="text-xs font-medium text-muted-foreground">
                  {LABELS[key] || key}
                  {low || bad ? (
                    <span className={bad ? "ml-2 text-red-600" : "ml-2 text-amber-600"}>
                      {bad ? "fail" : "low confidence"}
                    </span>
                  ) : null}
                </Label>
                <Input
                  data-testid={`field-${key}`}
                  className={bad ? "border-red-500" : low ? "border-amber-500" : undefined}
                  value={field.value}
                  onFocus={() => setActiveField(key)}
                  onChange={(e) => onFieldChange(key, e.target.value)}
                />
              </div>
            );
          })}

          <div>
            <Label className="text-xs font-medium text-muted-foreground">Line items</Label>
            <table className="mt-1 w-full text-sm" data-testid="review-line-items">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1">Description</th>
                  <th>VAT</th>
                  <th className="text-right">Net</th>
                  <th className="text-right">VAT amt</th>
                </tr>
              </thead>
              <tbody>
                {demo.line_items.map((l) => (
                  <tr key={l.description} className="border-t border-border">
                    <td className="py-1">{l.description}</td>
                    <td>{l.vatCode}</td>
                    <td className="text-right tabular-nums">{formatMinor(l.netMinor)}</td>
                    <td className="text-right tabular-nums">{formatMinor(l.vatMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => toast.success("Saved as profile (stub)")}
            >
              Save as profile
            </Button>
            <Button
              onClick={() =>
                toast.message("Confirm creates a draft document — approve separately")
              }
            >
              Confirm fields
            </Button>
            <Link
              className="inline-flex h-8 items-center text-sm text-primary underline"
              href="/books/statements"
            >
              Statement review
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
