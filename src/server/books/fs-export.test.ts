/**
 * P6-3: gated FS export — gate check, exact sheet totals, audit row.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  assertFsExportReady,
  exportBooksFinancialStatements,
  hashFsExportPayload,
} from "@/server/books/fs-export";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
import { createTestCompany } from "@/server/books/test-company";
import { withUser } from "@/lib/db";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";

async function withAdmin(t: test.TestContext) {
  const appUrl =
    process.env.DATABASE_URL || "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar_test";
  process.env.DATABASE_URL = appUrl;
  const adminUrl = process.env.DATABASE_URL_SUPER || appUrl.replace("://daftar_app:", "://daftar:");
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch {
    t.skip("Postgres is not reachable");
    return null;
  }
  return admin;
}

test("P6-3: assertFsExportReady refuses when any gate fails", () => {
  assert.throws(
    () =>
      assertFsExportReady({
        tbBalances: { ok: true, differenceMinor: 0 },
        bsBalances: { ok: false, differenceMinor: 50 },
        cfTies: { ok: true, differenceMinor: 0 },
        ready: false,
      }),
    /export_blocked_gates:bsBalances/,
  );
  assert.doesNotThrow(() =>
    assertFsExportReady({
      tbBalances: { ok: true, differenceMinor: 0 },
      bsBalances: { ok: true, differenceMinor: 0 },
      cfTies: { ok: true, differenceMinor: 0 },
      ready: true,
    }),
  );
});

test("P6-3: hashFsExportPayload is stable for the same numbers", () => {
  const base = {
    mode: "monthly",
    from: "2026-05-01",
    to: "2026-05-31",
    company: "Test",
    pnlNetByColumn: [6150],
    bsAssetsByColumn: [100000],
    bsEquityByColumn: [100000],
    cfCloseByColumn: [100000],
    tbTotalDebit: 100000,
    tbTotalCredit: 100000,
    integrity: {
      tbBalances: { ok: true, differenceMinor: 0 },
      bsBalances: { ok: true, differenceMinor: 0 },
      cfTies: { ok: true, differenceMinor: 0 },
      ready: true,
    },
  };
  assert.equal(hashFsExportPayload(base), hashFsExportPayload({ ...base }));
  assert.notEqual(
    hashFsExportPayload(base),
    hashFsExportPayload({ ...base, pnlNetByColumn: [6151] }),
  );
});

test("P6-3: xlsx export sheets carry exact NP / BS totals; audit written; pdf gated same", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p6-3-export");
    const may = company.periods["May 2026"];
    const bank = company.accountIdByCode["1120"];
    const capital = company.accountIdByCode["3100"];
    const rev = company.accountIdByCode["4100"];
    assert.ok(may && bank && capital && rev);

    // Capital 100_000 + cash sale 10_000 → NP 10_000, cash 110_000.
    const d1 = await createBooksJournal(OMAR, company.clientId, {
      periodId: may,
      entryDate: "2026-05-01",
      memo: "Capital",
      post: false,
      lines: [
        { accountId: bank, debitMinor: 100_000, creditMinor: 0 },
        { accountId: capital, debitMinor: 0, creditMinor: 100_000 },
      ],
    });
    await postBooksJournal(LAYLA, company.clientId, d1.id);
    const d2 = await createBooksJournal(OMAR, company.clientId, {
      periodId: may,
      entryDate: "2026-05-10",
      memo: "Sale",
      post: false,
      lines: [
        { accountId: bank, debitMinor: 10_000, creditMinor: 0 },
        { accountId: rev, debitMinor: 0, creditMinor: 10_000 },
      ],
    });
    await postBooksJournal(LAYLA, company.clientId, d2.id);

    const xlsx = await exportBooksFinancialStatements(OMAR, company.clientId, {
      format: "xlsx",
      mode: "monthly",
      from: "2026-05-01",
      to: "2026-05-31",
      asOf: "2026-12-31",
      preparedBy: "Omar Faris",
    });
    assert.equal(xlsx.integrity.ready, true);
    assert.ok(xlsx.contentHash.length === 64);
    assert.equal(xlsx.contentType.includes("spreadsheet"), true);

    const dir = mkdtempSync(path.join(tmpdir(), "p63-xlsx-"));
    const file = path.join(dir, "fs.xlsx");
    writeFileSync(file, xlsx.body);
    const out = execFileSync(
      "python3",
      [
        "-I",
        "-c",
        [
          "import sys, zipfile, json, xml.etree.ElementTree as ET",
          "z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None",
          "ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',",
          "      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}",
          "wb = ET.fromstring(z.read('xl/workbook.xml'))",
          "names = [s.get('name') for s in wb.findall('m:sheets/m:sheet', ns)]",
          "def cells(path):",
          "  sh = ET.fromstring(z.read(path)); d = {}",
          "  for c in sh.iter('{%s}c' % ns['m']):",
          "    v = c.find('m:v', ns); t = c.find('m:is/m:t', ns)",
          "    d[c.get('r')] = ('n', v.text) if v is not None else ('s', (t.text if t is not None else ''))",
          "  return d",
          "pnl = cells('xl/worksheets/sheet1.xml')",
          "bs = cells('xl/worksheets/sheet2.xml')",
          "print(json.dumps({'names': names, 'pnl': pnl, 'bs': bs}))",
        ].join("\n"),
        file,
      ],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(out) as {
      names: string[];
      pnl: Record<string, [string, string]>;
      bs: Record<string, [string, string]>;
    };
    assert.deepEqual(parsed.names, ["P&L", "Balance Sheet", "Cash Flow", "Trial Balance", "Notes"]);

    // Find Net profit row value in column B (first amount column).
    let np: string | null = null;
    for (const [ref, cell] of Object.entries(parsed.pnl)) {
      if (cell[0] === "s" && cell[1] === "Net profit") {
        const row = ref.replace(/^[A-Z]+/, "");
        np = parsed.pnl[`B${row}`]?.[1] ?? null;
      }
    }
    assert.equal(np, "100.00", "P&L net profit 10_000 fils = 100.00 AED");

    let assets: string | null = null;
    for (const [ref, cell] of Object.entries(parsed.bs)) {
      if (cell[0] === "s" && cell[1] === "Total assets") {
        const row = ref.replace(/^[A-Z]+/, "");
        assets = parsed.bs[`B${row}`]?.[1] ?? null;
      }
    }
    assert.equal(assets, "1100.00", "BS total assets 110_000 fils");

    const audits = await withUser(OMAR, async (db) => {
      const r = await db.query(
        `SELECT action, entity, after_json AS after
         FROM books_audit_events
         WHERE client_id = $1 AND entity = 'books_fs_export' AND action = 'export'
         ORDER BY at DESC LIMIT 5`,
        [company.clientId],
      );
      return r.rows;
    });
    assert.ok(audits.length >= 1);
    const after = audits[0].after as { contentHash?: string; format?: string };
    assert.equal(after.contentHash, xlsx.contentHash);
    assert.equal(after.format, "xlsx");

    const pdf = await exportBooksFinancialStatements(OMAR, company.clientId, {
      format: "pdf",
      mode: "monthly",
      from: "2026-05-01",
      to: "2026-05-31",
      asOf: "2026-12-31",
      preparedBy: "Omar Faris",
    });
    assert.ok(pdf.body.subarray(0, 5).toString("utf8") === "%PDF-");
    assert.match(pdf.body.toString("latin1"), /Arnifi/);
  } finally {
    await admin.end().catch(() => undefined);
  }
});
