/**
 * P6-3: gated financial-statement pack export (Excel multi-sheet + simple PDF).
 * Refuses when integrity gates fail; writes an audit event with payload hash.
 */
import { createHash, randomUUID } from "node:crypto";

import { withUser } from "@/lib/db";
import { getBooksCompanyProfile } from "@/server/books/accounts";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import {
  booksFinancialStatementsPack,
  parseMode,
  type BsColumn,
  type CfColumn,
  type FsIntegrity,
  type FsQuery,
  type PnlColumn,
} from "@/server/books/financial-statements";
import { buildSimplePdf } from "@/server/books/pdf";
import { booksTrialBalance } from "@/server/books/trial-balance";
import { buildMultiSheetXlsx } from "@/server/books/xlsx";
import { assertSyntheticTenant } from "@/server/security-gate";

export type FsExportFormat = "xlsx" | "pdf";

export type FsExportResult = {
  contentHash: string;
  fileName: string;
  contentType: string;
  body: Buffer;
  integrity: FsIntegrity;
  failingGates: string[];
};

function filsToDecimal(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(Math.trunc(minor));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

function cellAmount(minor: number): string {
  return minor === 0 ? "" : filsToDecimal(minor);
}

/** Pure gate check — unit-tested without DB. */
export function assertFsExportReady(integrity: FsIntegrity): string[] {
  const failing: string[] = [];
  if (!integrity.tbBalances.ok) failing.push("tbBalances");
  if (!integrity.bsBalances.ok) failing.push("bsBalances");
  if (!integrity.cfTies.ok) failing.push("cfTies");
  if (failing.length) {
    throw new BooksError(`export_blocked_gates:${failing.join(",")}`, "conflict");
  }
  return failing;
}

export function hashFsExportPayload(payload: {
  mode: string;
  from: string;
  to: string;
  company: string;
  pnlNetByColumn: number[];
  bsAssetsByColumn: number[];
  bsEquityByColumn: number[];
  cfCloseByColumn: number[];
  tbTotalDebit: number;
  tbTotalCredit: number;
  integrity: FsIntegrity;
}): string {
  const canonical = JSON.stringify({
    kind: "BOOKS_FS_EXPORT",
    mode: payload.mode,
    from: payload.from,
    to: payload.to,
    company: payload.company,
    pnlNetByColumn: payload.pnlNetByColumn,
    bsAssetsByColumn: payload.bsAssetsByColumn,
    bsEquityByColumn: payload.bsEquityByColumn,
    cfCloseByColumn: payload.cfCloseByColumn,
    tbTotalDebit: payload.tbTotalDebit,
    tbTotalCredit: payload.tbTotalCredit,
    integrity: payload.integrity,
    ruleVersion: "books-fs-export-v1",
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function headerRows(
  title: string,
  company: string,
  periodLabel: string,
  preparedBy: string,
  generatedAt: string,
): string[][] {
  return [
    [title],
    [company],
    [`${periodLabel} · AED · Prepared by ${preparedBy || "—"} · Generated ${generatedAt}`],
    [],
  ];
}

function pnlSheet(columns: PnlColumn[], meta: string[][]): string[][] {
  const labels = columns.map((c) => c.column.label);
  const rows: string[][] = [...meta, ["Particulars", ...labels]];
  const sectionOrder = ["PL_revenue", "PL_cogs", "PL_opex", "PL_depr", "PL_other", "PL_tax"];
  const keys = new Map<string, string>();
  for (const col of columns) for (const s of col.sections) keys.set(s.key, s.label);
  for (const key of sectionOrder) {
    if (!keys.has(key)) continue;
    rows.push([
      keys.get(key)!,
      ...columns.map((c) => cellAmount(c.sections.find((s) => s.key === key)?.totalMinor ?? 0)),
    ]);
    const accts = new Map<string, { code: string; name: string }>();
    for (const col of columns) {
      const sec = col.sections.find((s) => s.key === key);
      for (const a of sec?.accounts || []) accts.set(a.accountId, { code: a.code, name: a.name });
    }
    for (const [id, a] of accts) {
      rows.push([
        `  ${a.code} ${a.name}`,
        ...columns.map((c) => {
          const sec = c.sections.find((s) => s.key === key);
          return cellAmount(sec?.accounts.find((x) => x.accountId === id)?.amountMinor ?? 0);
        }),
      ]);
    }
    if (key === "PL_cogs") {
      rows.push(["Gross profit", ...columns.map((c) => cellAmount(c.grossProfitMinor))]);
    }
    if (key === "PL_opex") {
      rows.push(["EBITDA", ...columns.map((c) => cellAmount(c.ebitdaMinor))]);
    }
    if (key === "PL_depr") {
      rows.push(["EBIT", ...columns.map((c) => cellAmount(c.ebitMinor))]);
    }
    if (key === "PL_other") {
      rows.push(["EBT", ...columns.map((c) => cellAmount(c.ebtMinor))]);
    }
  }
  rows.push(["Net profit", ...columns.map((c) => cellAmount(c.netProfitMinor))]);
  return rows;
}

function bsSheet(columns: BsColumn[], meta: string[][]): string[][] {
  const labels = columns.map((c) => c.column.label);
  const rows: string[][] = [...meta, ["Particulars", ...labels]];
  const pushSections = (title: string, pick: (c: BsColumn) => typeof c.assets) => {
    rows.push([title, ...columns.map(() => "")]);
    const sectionKeys = new Map<string, string>();
    for (const col of columns) for (const s of pick(col)) sectionKeys.set(s.key, s.label);
    for (const [sKey, sLabel] of sectionKeys) {
      rows.push([
        `  ${sLabel}`,
        ...columns.map((c) => cellAmount(pick(c).find((s) => s.key === sKey)?.totalMinor ?? 0)),
      ]);
      const accts = new Map<string, { code: string; name: string }>();
      for (const col of columns) {
        for (const a of pick(col).find((s) => s.key === sKey)?.accounts || []) {
          accts.set(a.accountId, { code: a.code, name: a.name });
        }
      }
      for (const [id, a] of accts) {
        rows.push([
          `    ${a.code === "CYE" || a.code.startsWith("CYE") ? "" : a.code + " "}${a.name}`.trimEnd(),
          ...columns.map((c) =>
            cellAmount(
              pick(c).find((s) => s.key === sKey)?.accounts.find((x) => x.accountId === id)
                ?.amountMinor ?? 0,
            ),
          ),
        ]);
      }
    }
  };
  pushSections("Assets", (c) => c.assets);
  rows.push(["Total assets", ...columns.map((c) => cellAmount(c.totalAssetsMinor))]);
  pushSections("Liabilities", (c) => c.liabilities);
  pushSections("Equity", (c) => c.equity);
  rows.push([
    "Total liabilities + equity",
    ...columns.map((c) => cellAmount(c.totalLiabilitiesMinor + c.totalEquityMinor)),
  ]);
  return rows;
}

function cfSheet(columns: CfColumn[], meta: string[][]): string[][] {
  const labels = columns.map((c) => c.column.label);
  const rows: string[][] = [...meta, ["Particulars", ...labels]];
  const keys = new Map<string, string>();
  for (const col of columns) for (const l of col.lines) keys.set(l.key, l.label);
  for (const [key, label] of keys) {
    rows.push([
      label,
      ...columns.map((c) => cellAmount(c.lines.find((l) => l.key === key)?.amountMinor ?? 0)),
    ]);
  }
  return rows;
}

function tbSheet(
  tb: Awaited<ReturnType<typeof booksTrialBalance>>,
  meta: string[][],
): string[][] {
  const rows: string[][] = [
    ...meta,
    ["Code", "Account", "Closing Dr", "Closing Cr"],
  ];
  for (const g of tb.groups) {
    rows.push([g.label, "", "", ""]);
    for (const a of g.accounts) {
      rows.push([
        a.code,
        a.name,
        cellAmount(a.closingDebitMinor),
        cellAmount(a.closingCreditMinor),
      ]);
    }
  }
  rows.push([
    "",
    "Grand total",
    cellAmount(tb.totalClosingDebit),
    cellAmount(tb.totalClosingCredit),
  ]);
  return rows;
}

function notesSheet(
  company: string,
  periodLabel: string,
  preparedBy: string,
  generatedAt: string,
  integrity: FsIntegrity,
  contentHash: string,
): string[][] {
  return [
    ["Notes"],
    [company],
    [periodLabel],
    ["Currency", "AED"],
    ["Prepared by", preparedBy || "—"],
    ["Generated at", generatedAt],
    [],
    ["Accounting policies (placeholder)", "IFRS for SMEs eligible; accrual; UAE VAT 5% standard."],
    [],
    ["Integrity gates"],
    ["tbBalances", integrity.tbBalances.ok ? "pass" : "fail", filsToDecimal(integrity.tbBalances.differenceMinor)],
    ["bsBalances", integrity.bsBalances.ok ? "pass" : "fail", filsToDecimal(integrity.bsBalances.differenceMinor)],
    ["cfTies", integrity.cfTies.ok ? "pass" : "fail", filsToDecimal(integrity.cfTies.differenceMinor)],
    ["ready", integrity.ready ? "true" : "false"],
    [],
    ["Content hash (SHA-256)", contentHash],
  ];
}

function sheetToPdfLines(rows: string[][]): string[] {
  return rows.map((r) => r.filter((c) => c !== "").join("  |  "));
}

export async function exportBooksFinancialStatements(
  userId: string,
  clientId: string,
  opts: FsQuery & { format: FsExportFormat; preparedBy?: string },
): Promise<FsExportResult> {
  const mode = parseMode(opts.mode);
  const query: FsQuery = {
    mode,
    from: opts.from,
    to: opts.to,
    asOf: opts.asOf,
  };
  if (!query.from || !query.to) throw new BooksError("date_range_required", "invalid");
  if (opts.format !== "xlsx" && opts.format !== "pdf") {
    throw new BooksError("invalid_export_format", "invalid");
  }

  const pack = await booksFinancialStatementsPack(userId, clientId, query);
  try {
    assertFsExportReady(pack.integrity);
  } catch (e) {
    if (e instanceof BooksError && e.message.startsWith("export_blocked_gates:")) {
      // Re-throw; API maps to 409. Surface failing list for callers that catch.
      (e as BooksError & { failingGates?: string[] }).failingGates = e.message
        .slice("export_blocked_gates:".length)
        .split(",")
        .filter(Boolean);
    }
    throw e;
  }

  const company = await getBooksCompanyProfile(userId, clientId);
  const companyName = String(company?.name || "Company");
  const preparedBy = (opts.preparedBy || "").trim();
  const generatedAt = new Date().toISOString();
  const periodLabel = `${query.from} → ${query.to} (${mode})`;

  // Trial balance for the period covering `to`.
  const periodId = await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const row = await db.query(
      `SELECT id FROM books_periods
       WHERE client_id = $1 AND period_start <= $2::date AND period_end >= $2::date
       ORDER BY period_start DESC LIMIT 1`,
      [clientId, query.to],
    );
    if (!row.rowCount) throw new BooksError("period_not_found", "not_found");
    return String(row.rows[0].id);
  });
  const tb = await booksTrialBalance(userId, clientId, periodId, { includeZeroBalances: false });

  const hashPayload = {
    mode,
    from: query.from,
    to: query.to,
    company: companyName,
    pnlNetByColumn: pack.pnl.columns.map((c) => c.netProfitMinor),
    bsAssetsByColumn: pack.balanceSheet.columns.map((c) => c.totalAssetsMinor),
    bsEquityByColumn: pack.balanceSheet.columns.map((c) => c.totalEquityMinor),
    cfCloseByColumn: pack.cashFlow.columns.map((c) => c.closingCashMinor),
    tbTotalDebit: tb.totalClosingDebit,
    tbTotalCredit: tb.totalClosingCredit,
    integrity: pack.integrity,
  };
  const contentHash = hashFsExportPayload(hashPayload);

  const meta = (title: string) =>
    headerRows(title, companyName, periodLabel, preparedBy, generatedAt);

  const sheets = [
    { name: "P&L", rows: pnlSheet(pack.pnl.columns, meta("Profit & Loss")) },
    { name: "Balance Sheet", rows: bsSheet(pack.balanceSheet.columns, meta("Balance Sheet")) },
    { name: "Cash Flow", rows: cfSheet(pack.cashFlow.columns, meta("Cash Flow")) },
    { name: "Trial Balance", rows: tbSheet(tb, meta("Trial Balance")) },
    {
      name: "Notes",
      rows: notesSheet(companyName, periodLabel, preparedBy, generatedAt, pack.integrity, contentHash),
    },
  ];

  let body: Buffer;
  let contentType: string;
  let fileName: string;
  if (opts.format === "xlsx") {
    body = buildMultiSheetXlsx(sheets);
    contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    fileName = `financial-statements-${query.from}_${query.to}`;
  } else {
    body = buildSimplePdf({
      brand: "Arnifi · arnibooks",
      company: companyName,
      periodLabel,
      preparedBy,
      generatedAt,
      sections: sheets.map((s) => ({ title: s.name, lines: sheetToPdfLines(s.rows) })),
    });
    contentType = "application/pdf";
    fileName = `financial-statements-${query.from}_${query.to}`;
  }

  const exportId = randomUUID();
  await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "export",
      entity: "books_fs_export",
      entityId: exportId,
      after: {
        format: opts.format,
        mode,
        from: query.from,
        to: query.to,
        statementSet: sheets.map((s) => s.name),
        contentHash,
        byteSize: body.length,
        integrity: pack.integrity,
      },
      source: "app",
    });
  });

  return {
    contentHash,
    fileName,
    contentType,
    body,
    integrity: pack.integrity,
    failingGates: [],
  };
}
