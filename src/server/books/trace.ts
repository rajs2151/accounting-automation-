/**
 * ING-5b: read-only provenance chain for a document / inbox item / bank txn.
 * Uploaded → Extraction → Inbox → Document → Journal → Open item → Settlements → Reports.
 */
import { withUser } from "@/lib/db";
import { BooksError } from "@/server/books/errors";
import { assertSyntheticTenant } from "@/server/security-gate";

export type TraceStepStatus = "done" | "pending" | "failed" | "skipped";

export type TraceActor = { id: string; name: string | null };

export type TraceStep = {
  key: string;
  label: string;
  status: TraceStepStatus;
  at: string | null;
  actors: TraceActor[];
  detail: Record<string, unknown>;
  href: string | null;
};

export type TraceTieOut = {
  key: string;
  label: string;
  ok: boolean | null;
  detail: string | null;
};

export type TraceReportEffect = {
  label: string;
  amountMinor: number;
  href: string | null;
};

export type TraceResult = {
  kind: "document" | "inbox" | "bank-transaction";
  id: string;
  title: string;
  steps: TraceStep[];
  tieOuts: TraceTieOut[];
  reportEffects: TraceReportEffect[];
};

function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return s || null;
}

async function actorMap(
  db: Parameters<Parameters<typeof withUser>[1]>[0],
  ids: Array<string | null | undefined>,
): Promise<Map<string, string | null>> {
  const uniq = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const map = new Map<string, string | null>();
  if (!uniq.length) return map;
  const rows = await db.query(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [uniq]);
  for (const r of rows.rows) map.set(String(r.id), r.name == null ? null : String(r.name));
  return map;
}

function actorsOf(
  map: Map<string, string | null>,
  ...ids: Array<string | null | undefined>
): TraceActor[] {
  const out: TraceActor[] = [];
  for (const id of ids) {
    if (!id) continue;
    if (out.some((a) => a.id === id)) continue;
    out.push({ id, name: map.get(id) ?? null });
  }
  return out;
}

type DocRow = {
  id: string;
  client_id: string;
  doc_type: string;
  document_number: string | null;
  status: string;
  created_by: string | null;
  approved_by: string | null;
  journal_entry_id: string | null;
  issue_date: unknown;
  currency: string;
  original_total_minor: unknown;
  aed_total_minor: unknown;
  created_at: unknown;
  updated_at: unknown;
};

async function loadDocumentChain(
  db: Parameters<Parameters<typeof withUser>[1]>[0],
  clientId: string,
  doc: DocRow,
  inboxHintId?: string | null,
): Promise<TraceResult> {
  type InboxJoined = {
    id: string;
    status: string;
    file_id: string;
    detected_type: string | null;
    created_at: unknown;
    updated_at: unknown;
    filename: string;
    sha256: string;
    file_created_at: unknown;
    uploaded_by: string | null;
  };

  // Link: books_documents.extraction_id → books_extractions.inbox_item_id → inbox/file.
  const inboxFromDoc = await db.query(
    `SELECT i.id, i.status, i.file_id, i.detected_type, i.created_at, i.updated_at,
            f.filename, f.sha256, f.created_at AS file_created_at, f.uploaded_by
     FROM books_documents d
     JOIN books_extractions e ON e.id = d.extraction_id
     JOIN books_inbox_items i ON i.id = e.inbox_item_id
     JOIN books_files f ON f.id = i.file_id
     WHERE d.id = $1 AND d.client_id = $2
     LIMIT 1`,
    [doc.id, clientId],
  );
  let inbox = inboxFromDoc.rows[0] as InboxJoined | undefined;

  if (!inbox && inboxHintId) {
    const byId = await db.query(
      `SELECT i.id, i.status, i.file_id, i.detected_type, i.created_at, i.updated_at,
              f.filename, f.sha256, f.created_at AS file_created_at, f.uploaded_by
       FROM books_inbox_items i
       JOIN books_files f ON f.id = i.file_id
       WHERE i.client_id = $1 AND i.id = $2`,
      [clientId, inboxHintId],
    );
    inbox = byId.rows[0] as InboxJoined | undefined;
  }

  // Fallback: same file_id on the document.
  if (!inbox && (doc as { file_id?: string }).file_id) {
    const byFile = await db.query(
      `SELECT i.id, i.status, i.file_id, i.detected_type, i.created_at, i.updated_at,
              f.filename, f.sha256, f.created_at AS file_created_at, f.uploaded_by
       FROM books_inbox_items i
       JOIN books_files f ON f.id = i.file_id
       WHERE i.client_id = $1 AND i.file_id = $2
       ORDER BY i.created_at LIMIT 1`,
      [clientId, (doc as { file_id?: string }).file_id],
    );
    inbox = byFile.rows[0] as InboxJoined | undefined;
  }

  const extraction = inbox
    ? await db.query(
        `SELECT id, status, doc_type, fields_json, validation_flags, created_at, extractor_version
         FROM books_extractions
         WHERE client_id = $1 AND inbox_item_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [clientId, inbox.id],
      )
    : { rows: [] as Array<Record<string, unknown>>, rowCount: 0 };

  const je = doc.journal_entry_id
    ? await db.query(
        `SELECT e.id, e.entry_no, e.status, e.entry_date, e.created_by, e.posted_at, e.created_at,
                COALESCE(SUM(l.debit_minor),0)::bigint AS debit_sum,
                COALESCE(SUM(l.credit_minor),0)::bigint AS credit_sum
         FROM books_journal_entries e
         LEFT JOIN books_journal_lines l ON l.entry_id = e.id
         WHERE e.id = $1 AND e.client_id = $2
         GROUP BY e.id`,
        [doc.journal_entry_id, clientId],
      )
    : { rows: [] as Array<Record<string, unknown>>, rowCount: 0 };

  const jeLines = doc.journal_entry_id
    ? await db.query(
        `SELECT a.code, a.name, l.debit_minor, l.credit_minor, l.aed_minor,
                l.original_minor, l.currency
         FROM books_journal_lines l
         JOIN books_accounts a ON a.id = l.account_id
         WHERE l.entry_id = $1
         ORDER BY a.code`,
        [doc.journal_entry_id],
      )
    : { rows: [] as Array<Record<string, unknown>> };

  const openItem = await db.query(
    `SELECT id, side, currency, open_original_minor, open_aed_minor,
            aed_original_minor, original_minor, fx_rate_scaled
     FROM books_open_items WHERE client_id = $1 AND document_id = $2`,
    [clientId, doc.id],
  );

  const settlements = openItem.rowCount
    ? await db.query(
        `SELECT a.id, a.allocated_original_minor, a.allocated_aed_minor,
                s.id AS settlement_id, s.doc_type, s.document_number, s.issue_date, s.status
         FROM books_allocations a
         JOIN books_documents s ON s.id = a.settlement_document_id
         WHERE a.open_item_id = $1 AND s.client_id = $2 AND s.deleted_at IS NULL
         ORDER BY s.issue_date, a.id`,
        [openItem.rows[0].id, clientId],
      )
    : { rows: [] as Array<Record<string, unknown>>, rowCount: 0 };

  const auditIds = [
    inbox?.id,
    extraction.rows[0] ? String(extraction.rows[0].id) : null,
    doc.id,
    doc.journal_entry_id,
    openItem.rowCount ? String(openItem.rows[0].id) : null,
  ].filter(Boolean) as string[];

  const audits =
    auditIds.length > 0
      ? await db.query(
          `SELECT entity_id, action, actor, at
           FROM books_audit_events
           WHERE client_id = $1 AND entity_id = ANY($2::uuid[])
           ORDER BY at`,
          [clientId, auditIds],
        )
      : { rows: [] as Array<Record<string, unknown>> };

  const names = await actorMap(db, [
    inbox?.uploaded_by,
    doc.created_by,
    doc.approved_by,
    je.rows[0] ? String((je.rows[0] as { created_by?: string }).created_by) : null,
    doc.approved_by,
    ...audits.rows.map((r) => String(r.actor)),
  ]);

  const ext = extraction.rows[0] as
    | {
        id: string;
        status: string;
        doc_type: string;
        fields_json: Record<string, unknown>;
        validation_flags: unknown;
        created_at: unknown;
        extractor_version: string;
      }
    | undefined;

  const fields = (ext?.fields_json || {}) as Record<string, { value?: unknown; confidence?: number }>;
  const fieldSummary: Record<string, unknown> = {};
  for (const key of ["invoice_no", "document_number", "net", "vat", "gross", "grand_total", "currency"]) {
    if (fields[key]) {
      fieldSummary[key] = {
        value: fields[key].value ?? null,
        confidence: fields[key].confidence ?? null,
      };
    }
  }

  const steps: TraceStep[] = [];

  if (inbox) {
    steps.push({
      key: "uploaded",
      label: "Uploaded file",
      status: "done",
      at: iso(inbox.file_created_at),
      actors: actorsOf(names, inbox.uploaded_by),
      detail: {
        filename: inbox.filename,
        sha256: inbox.sha256,
        fileId: inbox.file_id,
      },
      href: `/books/inbox/${inbox.id}`,
    });
  } else {
    steps.push({
      key: "uploaded",
      label: "Uploaded file",
      status: "skipped",
      at: null,
      actors: [],
      detail: { note: "Manual document — no inbox upload" },
      href: null,
    });
  }

  if (ext) {
    const failed = String(ext.status) === "failed";
    steps.push({
      key: "extraction",
      label: "Extraction",
      status: failed ? "failed" : "done",
      at: iso(ext.created_at),
      actors: [],
      detail: {
        extractionId: ext.id,
        status: ext.status,
        docType: ext.doc_type,
        extractorVersion: ext.extractor_version,
        fields: fieldSummary,
        validationFlags: ext.validation_flags,
      },
      href: inbox ? `/books/inbox/${inbox.id}` : null,
    });
  } else {
    steps.push({
      key: "extraction",
      label: "Extraction",
      status: inbox ? "pending" : "skipped",
      at: null,
      actors: [],
      detail: inbox
        ? { note: "Waiting for worker extraction" }
        : { note: "No extraction for manual documents" },
      href: null,
    });
  }

  if (inbox) {
    const needsReview = ["needs_review", "queued", "extracting"].includes(String(inbox.status));
    steps.push({
      key: "inbox",
      label: "Inbox",
      status: String(inbox.status) === "confirmed" || doc.status !== "draft" ? "done" : needsReview ? "pending" : "done",
      at: iso(inbox.updated_at || inbox.created_at),
      actors: [],
      detail: {
        inboxItemId: inbox.id,
        status: inbox.status,
        detectedType: inbox.detected_type,
      },
      href: `/books/inbox/${inbox.id}`,
    });
  } else {
    steps.push({
      key: "inbox",
      label: "Inbox",
      status: "skipped",
      at: null,
      actors: [],
      detail: {},
      href: null,
    });
  }

  const docPending = String(doc.status) === "draft";
  steps.push({
    key: "document",
    label: "Document",
    status: docPending ? "pending" : String(doc.status) === "void" ? "failed" : "done",
    at: iso(doc.updated_at || doc.created_at),
    actors: actorsOf(names, doc.created_by, doc.approved_by),
    detail: {
      documentId: doc.id,
      documentNumber: doc.document_number,
      docType: doc.doc_type,
      status: doc.status,
      issueDate: iso(doc.issue_date)?.slice(0, 10) ?? null,
      currency: doc.currency,
      originalTotalMinor: Number(doc.original_total_minor),
      aedTotalMinor: Number(doc.aed_total_minor),
      pendingNote: docPending
        ? "Not posted yet — waiting for approval by someone other than the preparer"
        : null,
    },
    href: `/books/documents/${doc.id}`,
  });

  const jeRow = je.rows[0] as
    | {
        id: string;
        entry_no: string;
        status: string;
        entry_date: unknown;
        created_by: string;
        posted_at: unknown;
        debit_sum: unknown;
        credit_sum: unknown;
      }
    | undefined;

  if (jeRow) {
    const lines = jeLines.rows.map((r) => ({
      code: String(r.code),
      name: String(r.name),
      debitMinor: Number(r.debit_minor),
      creditMinor: Number(r.credit_minor),
      aedMinor: Number(r.aed_minor),
      originalMinor: r.original_minor == null ? null : Number(r.original_minor),
      currency: r.currency == null ? null : String(r.currency),
    }));
    steps.push({
      key: "journal",
      label: "Journal",
      status: String(jeRow.status) === "posted" ? "done" : "pending",
      at: iso(jeRow.posted_at || jeRow.entry_date),
      actors: actorsOf(names, jeRow.created_by, doc.approved_by),
      detail: {
        journalEntryId: jeRow.id,
        entryNo: jeRow.entry_no,
        status: jeRow.status,
        debitSum: Number(jeRow.debit_sum),
        creditSum: Number(jeRow.credit_sum),
        lines,
      },
      href: `/books/journals?highlight=${encodeURIComponent(jeRow.id)}`,
    });
  } else {
    steps.push({
      key: "journal",
      label: "Journal",
      status: "pending",
      at: null,
      actors: [],
      detail: {
        note: docPending
          ? "Not posted yet — waiting for approval by someone other than the preparer"
          : "No journal linked",
      },
      href: null,
    });
  }

  if (openItem.rowCount) {
    const oi = openItem.rows[0];
    steps.push({
      key: "open_item",
      label: "Open item",
      status: "done",
      at: null,
      actors: [],
      detail: {
        openItemId: oi.id,
        side: oi.side,
        currency: oi.currency,
        openOriginalMinor: Number(oi.open_original_minor),
        openAedMinor: Number(oi.open_aed_minor),
        originalMinor: Number(oi.original_minor ?? oi.aed_original_minor),
        aedOriginalMinor: Number(oi.aed_original_minor),
      },
      href: `/books/documents/${doc.id}`,
    });
  } else if (["sales_invoice", "purchase_bill"].includes(String(doc.doc_type)) && !docPending) {
    steps.push({
      key: "open_item",
      label: "Open item",
      status: "skipped",
      at: null,
      actors: [],
      detail: { note: "No open item (fully settled or not applicable)" },
      href: null,
    });
  } else {
    steps.push({
      key: "open_item",
      label: "Open item",
      status: docPending ? "pending" : "skipped",
      at: null,
      actors: [],
      detail: {},
      href: null,
    });
  }

  if (settlements.rowCount) {
    steps.push({
      key: "settlements",
      label: "Settlement(s)",
      status: "done",
      at: null,
      actors: [],
      detail: {
        items: settlements.rows.map((r) => ({
          settlementId: r.settlement_id,
          docType: r.doc_type,
          documentNumber: r.document_number,
          issueDate: iso(r.issue_date)?.slice(0, 10) ?? null,
          status: r.status,
          allocatedOriginalMinor: Number(r.allocated_original_minor),
          allocatedAedMinor: Number(r.allocated_aed_minor),
        })),
      },
      href: null,
    });
  } else {
    steps.push({
      key: "settlements",
      label: "Settlement(s)",
      status: openItem.rowCount && Number(openItem.rows[0].open_aed_minor) === 0 ? "done" : "pending",
      at: null,
      actors: [],
      detail: {
        note:
          openItem.rowCount && Number(openItem.rows[0].open_aed_minor) > 0
            ? "Open balance still outstanding"
            : "No settlements linked yet",
      },
      href: null,
    });
  }

  const reportEffects: TraceReportEffect[] = [];
  if (jeRow && String(jeRow.status) === "posted") {
    const aed = Number(doc.aed_total_minor);
    const isSales = ["sales_invoice", "credit_note"].includes(String(doc.doc_type));
    const sign = String(doc.doc_type) === "credit_note" || String(doc.doc_type) === "debit_note" ? -1 : 1;
    if (isSales) {
      const revLine = jeLines.rows.find((r) => String(r.code) === "4100");
      const rev = revLine ? Number(revLine.credit_minor) - Number(revLine.debit_minor) : 0;
      reportEffects.push({
        label: "P&L revenue (4100)",
        amountMinor: rev * sign,
        href: "/books/reports/pnl",
      });
      reportEffects.push({
        label: "BS / AR tile (gross AED)",
        amountMinor: aed * sign,
        href: "/books/reports/balance-sheet",
      });
    } else {
      reportEffects.push({
        label: "P&L expense impact (AED)",
        amountMinor: aed * sign,
        href: "/books/reports/pnl",
      });
    }
    const vatLine = jeLines.rows.find((r) => ["2210", "1430"].includes(String(r.code)));
    if (vatLine) {
      reportEffects.push({
        label: `VAT line ${vatLine.code}`,
        amountMinor: Number(vatLine.debit_minor) || Number(vatLine.credit_minor),
        href: "/books/reports/vat201",
      });
    }
  }

  steps.push({
    key: "reports",
    label: "Report effect",
    status: reportEffects.length ? "done" : "pending",
    at: null,
    actors: [],
    detail: { effects: reportEffects },
    href: "/books/reports",
  });

  const debitSum = jeRow ? Number(jeRow.debit_sum) : null;
  const creditSum = jeRow ? Number(jeRow.credit_sum) : null;
  const controlLine = jeLines.rows.find((r) => ["1210", "2110"].includes(String(r.code)));
  const controlAed = controlLine
    ? Math.abs(Number(controlLine.debit_minor) - Number(controlLine.credit_minor))
    : null;
  const oiOpen = openItem.rowCount ? Number(openItem.rows[0].aed_original_minor) : null;

  const tieOuts: TraceTieOut[] = [
    {
      key: "journal_balanced",
      label: "Journal Dr = Cr",
      ok: debitSum == null || creditSum == null ? null : debitSum === creditSum,
      detail:
        debitSum == null
          ? "Not posted yet"
          : debitSum === creditSum
            ? `${debitSum} = ${creditSum}`
            : `Dr ${debitSum} ≠ Cr ${creditSum}`,
    },
    {
      key: "open_equals_control",
      label: "Open item = control line",
      ok:
        controlAed == null || oiOpen == null
          ? null
          : controlAed === oiOpen ||
            (openItem.rowCount != null &&
              Number(openItem.rows[0].open_aed_minor) <= oiOpen &&
              controlAed === oiOpen),
      detail:
        controlAed == null || oiOpen == null
          ? "Waiting for post"
          : `control ${controlAed} · open original AED ${oiOpen}`,
    },
    {
      key: "vat_present",
      label: "VAT on journal when document has VAT",
      ok:
        Number(doc.aed_total_minor) === 0
          ? null
          : jeRow
            ? Boolean(jeLines.rows.some((r) => ["2210", "1430"].includes(String(r.code)))) ||
              Number(doc.original_total_minor) ===
                Number(
                  (fields.net?.value as number | undefined) ?? doc.original_total_minor,
                )
            : null,
      detail: jeRow ? "Checked journal VAT companions" : "Not posted yet",
    },
  ];

  const title =
    doc.document_number ||
    `${doc.doc_type} ${doc.id.slice(0, 8)}`;

  return {
    kind: "document",
    id: doc.id,
    title,
    steps,
    tieOuts,
    reportEffects,
  };
}

export async function traceBooksDocument(
  userId: string,
  clientId: string,
  idOrNumber: string,
): Promise<TraceResult> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const key = String(idOrNumber || "").trim();
    if (!key) throw new BooksError("trace_id_required", "invalid");

    // Prefer document id / number, then inbox id that already confirmed a document.
    let docRes = await db.query(
      `SELECT * FROM books_documents
       WHERE client_id = $1 AND deleted_at IS NULL
         AND (id::text = $2 OR document_number = $2)
       ORDER BY created_at DESC LIMIT 1`,
      [clientId, key],
    );

    let inboxHint: string | null = null;
    if (!docRes.rowCount) {
      const inbox = await db.query(
        `SELECT i.id,
                (
                  SELECT d.id FROM books_extractions e
                  JOIN books_documents d ON d.extraction_id = e.id AND d.deleted_at IS NULL
                  WHERE e.inbox_item_id = i.id
                  ORDER BY d.created_at DESC LIMIT 1
                ) AS document_id
         FROM books_inbox_items i
         WHERE i.client_id = $1 AND i.id::text = $2`,
        [clientId, key],
      );
      if (!inbox.rowCount) throw new BooksError("trace_not_found", "not_found");
      inboxHint = String(inbox.rows[0].id);
      if (inbox.rows[0].document_id) {
        docRes = await db.query(
          `SELECT * FROM books_documents WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
          [inbox.rows[0].document_id, clientId],
        );
      }
      if (!docRes.rowCount) {
        // Pre-confirm inbox: build a partial chain.
        const file = await db.query(
          `SELECT i.id, i.status, i.file_id, i.detected_type, i.created_at, i.updated_at,
                  f.filename, f.sha256, f.created_at AS file_created_at, f.uploaded_by
           FROM books_inbox_items i
           JOIN books_files f ON f.id = i.file_id
           WHERE i.id = $1 AND i.client_id = $2`,
          [inboxHint, clientId],
        );
        const row = file.rows[0];
        const ext = await db.query(
          `SELECT id, status, doc_type, fields_json, validation_flags, created_at, extractor_version
           FROM books_extractions WHERE inbox_item_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [inboxHint],
        );
        const names = await actorMap(db, [row?.uploaded_by]);
        const steps: TraceStep[] = [
          {
            key: "uploaded",
            label: "Uploaded file",
            status: "done",
            at: iso(row.file_created_at),
            actors: actorsOf(names, row.uploaded_by),
            detail: { filename: row.filename, sha256: row.sha256, fileId: row.file_id },
            href: `/books/inbox/${row.id}`,
          },
        ];
        if (ext.rowCount) {
          const e = ext.rows[0];
          steps.push({
            key: "extraction",
            label: "Extraction",
            status: String(e.status) === "failed" ? "failed" : "done",
            at: iso(e.created_at),
            actors: [],
            detail: {
              extractionId: e.id,
              status: e.status,
              docType: e.doc_type,
              fields: e.fields_json,
              validationFlags: e.validation_flags,
            },
            href: `/books/inbox/${row.id}`,
          });
        } else {
          steps.push({
            key: "extraction",
            label: "Extraction",
            status: "pending",
            at: null,
            actors: [],
            detail: { note: "Waiting for worker extraction" },
            href: null,
          });
        }
        steps.push({
          key: "inbox",
          label: "Inbox",
          status: "pending",
          at: iso(row.updated_at),
          actors: [],
          detail: {
            inboxItemId: row.id,
            status: row.status,
            note: "Not confirmed yet — waiting for preparer confirm",
          },
          href: `/books/inbox/${row.id}`,
        });
        for (const key of ["document", "journal", "open_item", "settlements", "reports"] as const) {
          steps.push({
            key,
            label:
              key === "document"
                ? "Document"
                : key === "journal"
                  ? "Journal"
                  : key === "open_item"
                    ? "Open item"
                    : key === "settlements"
                      ? "Settlement(s)"
                      : "Report effect",
            status: "pending",
            at: null,
            actors: [],
            detail: {
              note: "Not posted yet — waiting for approval by someone other than the preparer",
            },
            href: null,
          });
        }
        return {
          kind: "inbox",
          id: String(row.id),
          title: String(row.filename || row.id),
          steps,
          tieOuts: [
            {
              key: "journal_balanced",
              label: "Journal Dr = Cr",
              ok: null,
              detail: "Not posted yet",
            },
            {
              key: "open_equals_control",
              label: "Open item = control line",
              ok: null,
              detail: "Not posted yet",
            },
            {
              key: "vat_present",
              label: "VAT on journal when document has VAT",
              ok: null,
              detail: "Not posted yet",
            },
          ],
          reportEffects: [],
        };
      }
    }

    return loadDocumentChain(db, clientId, docRes.rows[0] as DocRow, inboxHint);
  });
}

export async function traceBooksBankTransaction(
  userId: string,
  clientId: string,
  txnId: string,
): Promise<TraceResult> {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const table = await db.query(`SELECT to_regclass('books_bank_transactions') AS t`);
    if (!table.rows[0]?.t) throw new BooksError("c3_bank_transactions_migration_required", "invalid");

    const txn = await db.query(
      `SELECT t.*, a.code AS account_code, a.name AS account_name
       FROM books_bank_transactions t
       JOIN books_accounts a ON a.id = t.account_id
       WHERE t.id = $1 AND t.client_id = $2`,
      [txnId, clientId],
    );
    if (!txn.rowCount) throw new BooksError("trace_not_found", "not_found");
    const row = txn.rows[0];
    const names = await actorMap(db, [row.reviewed_by]);

    const stmt = await db.query(
      `SELECT s.id, s.file_id, f.filename, f.sha256, s.status, s.created_at
       FROM books_statement_extractions s
       LEFT JOIN books_files f ON f.id = s.file_id
       WHERE s.id = $1`,
      [row.statement_id],
    );

    const jeId = row.journal_entry_id ? String(row.journal_entry_id) : null;
    const je = jeId
      ? await db.query(
          `SELECT id, entry_no, status, posted_at FROM books_journal_entries WHERE id = $1`,
          [jeId],
        )
      : { rows: [] as Array<Record<string, unknown>>, rowCount: 0 };

    const steps: TraceStep[] = [
      {
        key: "uploaded",
        label: "Statement file",
        status: stmt.rowCount ? "done" : "skipped",
        at: stmt.rowCount ? iso(stmt.rows[0].created_at) : null,
        actors: [],
        detail: stmt.rowCount
          ? {
              filename: stmt.rows[0].filename,
              sha256: stmt.rows[0].sha256,
              statementId: stmt.rows[0].id,
            }
          : {},
        href: stmt.rowCount ? `/books/statements/${stmt.rows[0].id}` : null,
      },
      {
        key: "materialized",
        label: "Bank transaction",
        status: "done",
        at: iso(row.created_at),
        actors: actorsOf(names, row.reviewed_by),
        detail: {
          txnId: row.id,
          accountCode: row.account_code,
          accountName: row.account_name,
          txnDate: iso(row.txn_date)?.slice(0, 10),
          description: row.description,
          currency: row.currency,
          debitMinor: Number(row.debit_minor),
          creditMinor: Number(row.credit_minor),
          reviewStatus: row.review_status,
          txnType: row.txn_type,
        },
        href: "/books/transactions",
      },
      {
        key: "journal",
        label: "Journal",
        status: je.rowCount ? "done" : String(row.review_status) === "excluded" ? "skipped" : "pending",
        at: je.rowCount ? iso(je.rows[0].posted_at) : null,
        actors: [],
        detail: je.rowCount
          ? { entryNo: je.rows[0].entry_no, journalEntryId: je.rows[0].id }
          : {
              note:
                String(row.review_status) === "ready"
                  ? "Ready — waiting for approval by someone other than the reviewer"
                  : "Not posted yet",
            },
        href: je.rowCount
          ? `/books/journals?highlight=${encodeURIComponent(String(je.rows[0].id))}`
          : null,
      },
    ];

    return {
      kind: "bank-transaction",
      id: String(row.id),
      title: String(row.description || row.id),
      steps,
      tieOuts: [
        {
          key: "posted_or_pending",
          label: "Posted or still in review",
          ok: je.rowCount ? true : String(row.review_status) !== "posted" ? null : false,
          detail: String(row.review_status),
        },
      ],
      reportEffects: [],
    };
  });
}
