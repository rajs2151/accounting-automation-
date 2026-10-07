/**
 * P6-2 reports hardening: reclass side / source checks / period, P&L "other" net, PDF columns and
 * WinAnsi text, BS drill opening, synthetic equity lines, fiscal query range, export MFA.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import * as tree from "@/lib/fs-report-tree";
import { booksFinancialStatementsPack } from "@/server/books/financial-statements";
import * as fsExport from "@/server/books/fs-export";
import { createBooksJournal, getBooksJournal, postBooksJournal } from "@/server/books/journals";
import { booksAccountLinesInRange } from "@/server/books/ledger-report";
import { buildSimplePdf } from "@/server/books/pdf";
import { createBooksReclassDraft } from "@/server/books/reclass";
import { createTestCompany, type TestCompany } from "@/server/books/test-company";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";

type LineIn = { accountId: string; debitMinor: number; creditMinor: number };
const L = (accountId: string, debitMinor: number, creditMinor: number): LineIn => ({
  accountId,
  debitMinor,
  creditMinor,
});

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

async function postJv(
  co: TestCompany,
  periodLabel: string,
  entryDate: string,
  lines: LineIn[],
  extra: { entryType?: string; memo?: string } = {},
) {
  const d = await createBooksJournal(OMAR, co.clientId, {
    periodId: co.periods[periodLabel],
    entryDate,
    memo: extra.memo || "p62 test",
    entryType: extra.entryType,
    post: false,
    lines,
  });
  await postBooksJournal(LAYLA, co.clientId, d.id);
  return d.id as string;
}

function linesByAccount(full: { lines: Array<{ accountId: string; debitMinor: number; creditMinor: number }> }) {
  return new Map(full.lines.map((l) => [l.accountId, { dr: Number(l.debitMinor), cr: Number(l.creditMinor) }]));
}

/** Text runs of one page (content stream `page`, 0-based) of a PDF built by pdf.ts. */
function pdfRuns(buf: Buffer, page = 0) {
  const all = buf.toString("latin1");
  const s = all.split("\nstream\n")[page + 1]?.split("\nendstream")[0] ?? "";
  const out: Array<{ x: number; y: number; text: string }> = [];
  const re = /BT \/F1 [\d.]+ Tf ([\d.]+) ([\d.]+) Td \(((?:\\.|[^\\)])*)\) Tj ET/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out.push({ x: Number(m[1]), y: Number(m[2]), text: m[3].replace(/\\(.)/g, "$1") });
  }
  return out;
}

// ---------------------------------------------------------------- #1 / #2 / #7 reclass

test("P6-2 #1: credit-side (revenue) reclass moves the revenue instead of doubling it", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const co = await createTestCompany(admin, "p62-rc-credit");
    const A = co.accountIdByCode;
    const sale = await postJv(co, "May 2026", "2026-05-10", [L(A["1120"], 10_000, 0), L(A["4100"], 0, 10_000)]);
    const rc = await createBooksReclassDraft(OMAR, co.clientId, {
      periodId: co.periods["May 2026"],
      entryDate: "2026-05-10",
      fromAccountId: A["4100"],
      toAccountId: A["4200"],
      amountMinor: 10_000,
      sourceEntryId: sale,
    });
    const full = await getBooksJournal(OMAR, co.clientId, rc.id);
    const by = linesByAccount(full);
    assert.deepEqual(by.get(A["4100"]), { dr: 10_000, cr: 0 }, "credit-side source: Dr from");
    assert.deepEqual(by.get(A["4200"]), { dr: 0, cr: 10_000 }, "credit-side source: Cr to");
    await postBooksJournal(LAYLA, co.clientId, rc.id);
    const pack = await booksFinancialStatementsPack(OMAR, co.clientId, {
      mode: "range",
      from: "2026-05-01",
      to: "2026-05-31",
      asOf: "2099-12-31",
    });
    const rev = pack.pnl.columns[0].sections.find((s) => s.key === "PL_revenue")!;
    const amt = (code: string) => rev.accounts.find((a) => a.code === code)?.amountMinor ?? 0;
    assert.equal(amt("4100"), 0, "4100 emptied");
    assert.equal(amt("4200"), 10_000, "4200 now holds the revenue");
    assert.equal(rev.totalMinor, 10_000, "revenue total unchanged");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P6-2 #2: reclass checks the source entry, cap, whole fils, statement and control accounts", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const co = await createTestCompany(admin, "p62-rc-source");
    const other = await createTestCompany(admin, "p62-rc-other");
    const A = co.accountIdByCode;
    const may = co.periods["May 2026"];
    const rent = await postJv(co, "May 2026", "2026-05-11", [L(A["6200"], 10_000, 0), L(A["1120"], 0, 10_000)]);
    const sale = await postJv(co, "May 2026", "2026-05-12", [L(A["1120"], 7_000, 0), L(A["4100"], 0, 7_000)]);
    const base = {
      periodId: may,
      entryDate: "2026-05-11",
      fromAccountId: A["6200"],
      toAccountId: A["6210"],
      sourceEntryId: rent,
    };

    await assert.rejects(
      () => createBooksReclassDraft(OMAR, co.clientId, { ...base, amountMinor: 9_999_999 }),
      /reclass_amount_exceeds_source:10000/,
    );
    await assert.rejects(
      () => createBooksReclassDraft(OMAR, co.clientId, { ...base, amountMinor: 50.7 }),
      /reclass_amount_invalid/,
    );
    // Cap counts earlier drafts of the same source + from-account.
    await createBooksReclassDraft(OMAR, co.clientId, { ...base, amountMinor: 6_000 });
    await assert.rejects(
      () => createBooksReclassDraft(OMAR, co.clientId, { ...base, amountMinor: 5_000 }),
      /reclass_amount_exceeds_source:4000/,
    );
    const rest = await createBooksReclassDraft(OMAR, co.clientId, { ...base, amountMinor: 4_000 });
    assert.equal(rest.status, "draft");
    const restFull = await getBooksJournal(OMAR, co.clientId, rest.id);
    assert.equal(restFull.correctsEntryId, rent, "draft links to its source entry");

    // Source that never touches the from-account.
    await assert.rejects(
      () => createBooksReclassDraft(OMAR, co.clientId, { ...base, sourceEntryId: sale, amountMinor: 100 }),
      /reclass_source_no_line/,
    );
    // Draft source.
    const draft = await createBooksJournal(OMAR, co.clientId, {
      periodId: may,
      entryDate: "2026-05-14",
      memo: "draft",
      post: false,
      lines: [L(A["6200"], 500, 0), L(A["1120"], 0, 500)],
    });
    await assert.rejects(
      () => createBooksReclassDraft(OMAR, co.clientId, { ...base, sourceEntryId: draft.id, amountMinor: 100 }),
      /reclass_source_not_posted/,
    );
    // Another client's entry is not found under this client.
    const foreign = await postJv(other, "May 2026", "2026-05-11", [
      L(other.accountIdByCode["6200"], 1_000, 0),
      L(other.accountIdByCode["1120"], 0, 1_000),
    ]);
    await assert.rejects(
      () => createBooksReclassDraft(OMAR, co.clientId, { ...base, sourceEntryId: foreign, amountMinor: 100 }),
      /reclass_source_not_found/,
    );
    // Cross-statement: expense → prepaid / AR control / bank.
    for (const code of ["1410", "1210", "1121"]) {
      await assert.rejects(
        () => createBooksReclassDraft(OMAR, co.clientId, { ...base, toAccountId: A[code], amountMinor: 100 }),
        /reclass_cross_statement/,
        `6200 → ${code} refused`,
      );
    }
    // Control accounts on the balance sheet side: bank → bank, bank → prepaid.
    const xfer = await postJv(co, "May 2026", "2026-05-13", [L(A["1410"], 2_000, 0), L(A["1120"], 0, 2_000)]);
    await assert.rejects(
      () =>
        createBooksReclassDraft(OMAR, co.clientId, {
          ...base,
          sourceEntryId: xfer,
          fromAccountId: A["1120"],
          toAccountId: A["1121"],
          amountMinor: 100,
        }),
      /reclass_control_account/,
    );
    await assert.rejects(
      () =>
        createBooksReclassDraft(OMAR, co.clientId, {
          ...base,
          sourceEntryId: xfer,
          fromAccountId: A["1410"],
          toAccountId: A["1210"],
          amountMinor: 100,
        }),
      /reclass_control_account/,
    );
    // BS → BS between ordinary accounts is fine (prepaid → deposits).
    const ok = await createBooksReclassDraft(OMAR, co.clientId, {
      ...base,
      sourceEntryId: xfer,
      fromAccountId: A["1410"],
      toAccountId: A["1420"],
      amountMinor: 2_000,
    });
    assert.equal(ok.status, "draft");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P6-2 #7: reclass is dated in the line's own period; a locked one is refused", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const co = await createTestCompany(admin, "p62-rc-period");
    const A = co.accountIdByCode;
    const apr = co.periods["Apr 2026"];
    const may = co.periods["May 2026"];
    const aprRent = await postJv(co, "Apr 2026", "2026-04-10", [L(A["6200"], 3_000, 0), L(A["1120"], 0, 3_000)]);
    // UI sends the selected period (May) with the April line's date.
    const rc = await createBooksReclassDraft(OMAR, co.clientId, {
      periodId: may,
      entryDate: "2026-04-10",
      fromAccountId: A["6200"],
      toAccountId: A["6210"],
      amountMinor: 1_000,
      sourceEntryId: aprRent,
    });
    const full = await getBooksJournal(OMAR, co.clientId, rc.id);
    assert.equal(full.periodId, apr, "booked in April, the period containing entryDate");
    await admin.query(`UPDATE books_periods SET status = 'LOCKED' WHERE id = $1`, [apr]);
    await assert.rejects(
      () =>
        createBooksReclassDraft(OMAR, co.clientId, {
          periodId: may,
          entryDate: "2026-04-10",
          fromAccountId: A["6200"],
          toAccountId: A["6210"],
          amountMinor: 500,
          sourceEntryId: aprRent,
        }),
      /period_locked/,
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});

// ---------------------------------------------------------------- #3 / #4 / #11 statements & exports

test("P6-2 #3/#4/#11: 'Other income / finance' shows its net; PDF keeps columns; negatives bracketed", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const co = await createTestCompany(admin, "p62-other");
    const A = co.accountIdByCode;
    await postJv(co, "Apr 2026", "2026-04-11", [L(A["6200"], 5_000, 0), L(A["1120"], 0, 5_000)]);
    await postJv(co, "May 2026", "2026-05-01", [L(A["1120"], 100_000, 0), L(A["3100"], 0, 100_000)]);
    await postJv(co, "May 2026", "2026-05-12", [L(A["1120"], 7_000, 0), L(A["4100"], 0, 7_000)]);
    await postJv(co, "May 2026", "2026-05-13", [L(A["1120"], 10_000, 0), L(A["7100"], 0, 10_000)]);
    await postJv(co, "May 2026", "2026-05-14", [L(A["7400"], 3_000, 0), L(A["1120"], 0, 3_000)]);
    const q = { mode: "monthly" as const, from: "2026-04-01", to: "2026-05-31", asOf: "2099-12-31" };

    const pack = await booksFinancialStatementsPack(OMAR, co.clientId, q);
    const mayCol = pack.pnl.columns[1];
    const other = mayCol.sections.find((s) => s.key === "PL_other")!;
    assert.equal(other.netMinor, 7_000, "engine: signed net of other");
    assert.equal(other.netMinor, mayCol.ebtMinor - mayCol.ebitMinor);
    assert.equal(other.totalMinor, 13_000, "totalMinor kept backward compatible");

    const pt = tree.pnlToReportTree(pack.pnl.columns);
    const row = pt.rows.find((r) => r.id === "PL_other")!;
    const key = mayCol.column.key;
    assert.equal(row.values[key], 7_000, "screen: section total = EBT − EBIT");
    const child = (code: string) => row.children!.find((c) => c.code === code)!;
    assert.equal(child("7100").values[key], 10_000);
    assert.equal(child("7400").values[key], -3_000, "expense in other shown negative");

    // Projection-style column without netMinor: total falls back to EBT − EBIT, sign reused.
    const projected = {
      column: { key: "proj", label: "Jun 2026", from: "2026-06-01", to: "2026-06-30" },
      sections: [
        {
          key: "PL_other",
          label: "Other income / finance",
          totalMinor: 1_300,
          accounts: [
            { accountId: A["7100"], code: "7100", name: "Interest income", amountMinor: 1_000 },
            { accountId: A["7400"], code: "7400", name: "Interest expense", amountMinor: 300 },
          ],
        },
      ],
      grossProfitMinor: 0,
      ebitdaMinor: 0,
      ebitMinor: 0,
      ebtMinor: 700,
      netProfitMinor: 700,
    };
    const pt2 = tree.pnlToReportTree([...pack.pnl.columns, projected]);
    const row2 = pt2.rows.find((r) => r.id === "PL_other")!;
    assert.equal(row2.values.proj, 700);
    assert.equal(row2.children!.find((c) => c.code === "7400")!.values.proj, -300);

    // PDF: every amount stays in its column; Apr has no revenue so its cell is "–".
    const pdf = await fsExport.exportBooksFinancialStatements(OMAR, co.clientId, { ...q, format: "pdf" });
    const runs = pdfRuns(pdf.body);
    const header = runs.find((r) => r.text === "Particulars")!;
    assert.ok(header, "table header run");
    const headRow = runs.filter((r) => r.y === header.y);
    const aprHead = headRow.find((r) => r.text === "Apr 2026")!;
    const mayHead = headRow.find((r) => r.text === "May 2026")!;
    assert.ok(aprHead && mayHead && mayHead.x > aprHead.x);
    const rowRuns = (label: string) => {
      const lab = runs.find((r) => r.text === label && r.y < header.y)!;
      assert.ok(lab, `row ${label}`);
      return runs.filter((r) => r.y === lab.y && r !== lab).sort((a, b) => a.x - b.x);
    };
    const revenue = rowRuns("Revenue");
    assert.equal(revenue.length, 2, "two amount cells, blank kept");
    assert.equal(revenue[0].text, "\x96", "blank April cell prints an en dash");
    assert.equal(revenue[1].text, "70.00", "May revenue in the May column");
    assert.ok(revenue[1].x > aprHead.x, "May value right of the April column");
    const otherRow = rowRuns("Other income / finance");
    assert.equal(otherRow[1].text, "70.00", "PDF: other = net 70.00, not 130.00");
    const intExp = rowRuns("  7400 Interest expense");
    assert.equal(intExp[1].text, "(30.00)", "PDF: negative in brackets");

    // Excel: same numbers; negatives bracketed (xlsx.ts has no number formats).
    const xlsx = await fsExport.exportBooksFinancialStatements(OMAR, co.clientId, { ...q, format: "xlsx" });
    const dir = mkdtempSync(path.join(tmpdir(), "p62-xlsx-"));
    const file = path.join(dir, "fs.xlsx");
    writeFileSync(file, xlsx.body);
    const out = execFileSync(
      "python3",
      [
        "-I",
        "-c",
        [
          "import sys, zipfile, json, xml.etree.ElementTree as ET",
          "z = zipfile.ZipFile(sys.argv[1])",
          "m = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'",
          "rows = []",
          "for r in ET.fromstring(z.read('xl/worksheets/sheet1.xml')).iter(m + 'row'):",
          "  cells = {}",
          "  for c in r.iter(m + 'c'):",
          "    v = c.find(m + 'v'); t = c.find(m + 'is/' + m + 't')",
          "    cells[''.join(ch for ch in c.get('r') if ch.isalpha())] = v.text if v is not None else (t.text if t is not None else '')",
          "  rows.append(cells)",
          "print(json.dumps(rows))",
        ].join("\n"),
        file,
      ],
      { encoding: "utf8" },
    );
    const sheet = JSON.parse(out) as Array<Record<string, string>>;
    const xrow = (label: string) => sheet.find((r) => r.A === label)!;
    assert.equal(xrow("Other income / finance").C, "70.00", "Excel: other = net");
    assert.equal(xrow("  7400 Interest expense").C, "(30.00)", "Excel: expense in other bracketed");
    assert.equal(xrow("  7100 Interest income").C, "100.00");

    assert.equal(fsExport.cellAmount(-12_345), "(123.45)");
    assert.equal(fsExport.cellAmount(12_345), "123.45");
    assert.equal(fsExport.cellAmount(-5), "(0.05)");
    assert.equal(fsExport.cellAmount(0), "");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

// ---------------------------------------------------------------- #5 / #6 drill

test("P6-2 #5/#6: BS drill = opening + period lines (closing entries kept); synthetic lines not drillable", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const co = await createTestCompany(admin, "p62-drill");
    const A = co.accountIdByCode;
    await postJv(co, "Apr 2026", "2026-04-10", [L(A["1120"], 30_000, 0), L(A["4100"], 0, 30_000)]);
    await postJv(co, "May 2026", "2026-05-10", [L(A["1120"], 10_000, 0), L(A["4100"], 0, 10_000)]);
    await postJv(co, "May 2026", "2026-05-11", [L(A["6200"], 5_000, 0), L(A["1120"], 0, 5_000)]);
    // A closing entry in May: income → retained earnings.
    await postJv(co, "May 2026", "2026-05-31", [L(A["4100"], 40_000, 0), L(A["3200"], 0, 40_000)], {
      entryType: "closing",
      memo: "close",
    });
    const q = { mode: "monthly" as const, from: "2026-04-01", to: "2026-05-31", asOf: "2099-12-31" };
    const pack = await booksFinancialStatementsPack(OMAR, co.clientId, q);
    const mayBs = pack.balanceSheet.columns[1];
    const cell = (code: string) =>
      [...mayBs.assets, ...mayBs.liabilities, ...mayBs.equity]
        .flatMap((s) => s.accounts)
        .find((a) => a.code === code)?.amountMinor ?? 0;

    const bank = await booksAccountLinesInRange(OMAR, co.clientId, {
      accountId: A["1120"],
      from: mayBs.column.from,
      to: mayBs.column.to,
    });
    assert.equal(bank.statement, "bs");
    assert.equal(bank.openingMinor, 30_000, "opening = balance at from − 1");
    assert.equal(bank.totalMinor, cell("1120"), "opening + lines = BS cell");
    assert.equal(bank.totalMinor, 35_000);

    const re = await booksAccountLinesInRange(OMAR, co.clientId, {
      accountId: A["3200"],
      from: mayBs.column.from,
      to: mayBs.column.to,
    });
    assert.equal(re.lines.length, 1, "closing entry kept for retained earnings");
    assert.equal(re.totalMinor, cell("3200"));
    assert.equal(re.totalMinor, 40_000);

    const rev = await booksAccountLinesInRange(OMAR, co.clientId, {
      accountId: A["4100"],
      from: "2026-05-01",
      to: "2026-05-31",
    });
    assert.equal(rev.statement, "pnl");
    assert.equal(rev.openingMinor, 0);
    assert.deepEqual(rev.lines.map((l) => l.amountMinor), [-10_000], "P&L drill still excludes closing");
    assert.equal(rev.totalMinor, 10_000, "presented in the P&L sign");

    // #6: synthetic equity line (prior years not closed) has no drill and no code.
    const bsTree = tree.bsToReportTree([
      {
        column: { key: "c1", label: "May 2026", from: "2026-05-01", to: "2026-05-31" },
        assets: [],
        liabilities: [],
        equity: [
          {
            key: "BS_equity",
            label: "Equity",
            totalMinor: 300,
            accounts: [
              { accountId: A["3100"], code: "3100", name: "Share capital", amountMinor: 100 },
              { accountId: "synthetic:pye", code: "PYE", name: "Prior years' profit not yet closed", amountMinor: 100 },
              { accountId: "synthetic:cye", code: "CYE", name: "Current year profit", amountMinor: 100 },
            ],
          },
        ],
        totalAssetsMinor: 0,
        totalLiabilitiesMinor: 0,
        totalEquityMinor: 300,
      },
    ]);
    const eq = bsTree.rows.find((r) => r.id === "equity")!.children![0].children!;
    const pye = eq.find((r) => r.label.startsWith("Prior years"))!;
    const cye = eq.find((r) => r.label === "Current year profit")!;
    const cap = eq.find((r) => r.label === "Share capital")!;
    assert.equal(pye.drill, undefined, "PYE not drillable");
    assert.equal(pye.code, undefined, "PYE code hidden");
    assert.equal(cye.drill, undefined);
    assert.ok(cap.drill, "real accounts keep their drill");
    await assert.rejects(
      () => booksAccountLinesInRange(OMAR, co.clientId, { accountId: "synthetic:pye", from: "2026-05-01", to: "2026-05-31" }),
      /invalid_account_id/,
    );

    // Excel BS sheet: no "PYE" code printed.
    const company2 = await createTestCompany(admin, "p62-pye");
    const B = company2.accountIdByCode;
    // 2025 profit never closed → PYE line in 2026.
    await admin.query(
      `INSERT INTO books_periods (id, client_id, label, period_start, period_end, status)
       VALUES (gen_random_uuid(), $1, 'Dec 2025', '2025-12-01', '2025-12-31', 'OPEN')
       ON CONFLICT DO NOTHING`,
      [company2.clientId],
    );
    const dec = await admin.query(
      `SELECT id FROM books_periods WHERE client_id = $1 AND period_start = '2025-12-01'`,
      [company2.clientId],
    );
    const decId = String(dec.rows[0].id);
    const dj = await createBooksJournal(OMAR, company2.clientId, {
      periodId: decId,
      entryDate: "2025-12-15",
      memo: "2025 sale",
      post: false,
      lines: [L(B["1120"], 2_500, 0), L(B["4100"], 0, 2_500)],
    });
    await postBooksJournal(LAYLA, company2.clientId, dj.id);
    const x = await fsExport.exportBooksFinancialStatements(OMAR, company2.clientId, {
      mode: "monthly",
      from: "2026-05-01",
      to: "2026-05-31",
      asOf: "2099-12-31",
      format: "xlsx",
    });
    const dir = mkdtempSync(path.join(tmpdir(), "p62-pye-"));
    writeFileSync(path.join(dir, "bs.xlsx"), x.body);
    const sheet2 = execFileSync(
      "python3",
      ["-I", "-c", "import sys, zipfile; print(zipfile.ZipFile(sys.argv[1]).read('xl/worksheets/sheet2.xml').decode())", path.join(dir, "bs.xlsx")],
      { encoding: "utf8" },
    );
    assert.match(sheet2, /Prior years&apos;? ?profit|Prior years' profit/);
    assert.doesNotMatch(sheet2, /PYE/, "no synthetic code in Excel");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

// ---------------------------------------------------------------- #8 fiscal query range

test("P6-2 #8: quarterly / yearly query range follows the fiscal calendar", () => {
  const f = tree.fiscalRangeForPeriod;
  assert.deepEqual(f("quarterly", "2026-08-01", 1), { from: "2026-07-01", to: "2026-09-30" });
  assert.deepEqual(f("quarterly", "2026-02-01", 4), { from: "2026-01-01", to: "2026-03-31" });
  assert.deepEqual(f("quarterly", "2026-04-01", 4), { from: "2026-04-01", to: "2026-06-30" });
  assert.deepEqual(f("yearly", "2026-08-01", 4), { from: "2026-04-01", to: "2027-03-31" });
  assert.deepEqual(f("yearly", "2026-02-01", 4), { from: "2025-04-01", to: "2026-03-31" });
  assert.deepEqual(f("yearly", "2026-05-01", 1), { from: "2026-01-01", to: "2026-12-31" });
  assert.deepEqual(f("quarterly", "2026-12-01", 11), { from: "2026-11-01", to: "2027-01-31" });
});

// ---------------------------------------------------------------- #9 PDF text encoding

test("P6-2 #9: PDF writes WinAnsi bytes (· — é ok, Arabic → ?), offsets and /Length exact", () => {
  const buf = buildSimplePdf({
    brand: "Arnifi · arnibooks",
    company: "Café Co — عمر",
    periodLabel: "2026-05-01 → 2026-05-31 (monthly)",
    preparedBy: "",
    generatedAt: "2026-10-07T00:00:00.000Z",
    sections: [{ title: "Notes", lines: ["a · b — c"] }],
  });
  const has = (bytes: number[]) => buf.indexOf(Buffer.from(bytes)) >= 0;
  assert.ok(has([0x41, 0x72, 0x6e, 0x69, 0x66, 0x69, 0x20, 0xb7, 0x20]), "· is 0xB7");
  assert.ok(has([0x20, 0x97, 0x20]), "— is 0x97");
  assert.ok(has([0x43, 0x61, 0x66, 0xe9]), "é is 0xE9");
  assert.ok(!has([0xc2, 0xb7]) && !has([0xe2, 0x80, 0x94]), "no UTF-8 sequences");
  const text = buf.toString("latin1");
  assert.match(text, /Caf\xe9 Co \x97 \?\?\?/, "Arabic becomes ? without corrupting the rest");
  assert.match(text, /\/Encoding \/WinAnsiEncoding/);
  // /Length equals the stream's byte length, and every xref offset points at its object.
  const re = /<< \/Length (\d+) >>\nstream\n/g;
  let m: RegExpExecArray | null;
  let streams = 0;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    assert.equal(text.slice(start + Number(m[1]), start + Number(m[1]) + 10), "\nendstream");
    streams += 1;
  }
  assert.ok(streams >= 1);
  const xrefAt = Number(/startxref\n(\d+)/.exec(text)![1]);
  assert.equal(text.slice(xrefAt, xrefAt + 4), "xref");
  const entries = text.slice(xrefAt).split("\n").slice(3).filter((l) => / 00000 n $/.test(l));
  entries.forEach((l, i) => {
    const off = Number(l.slice(0, 10));
    assert.equal(text.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`);
  });
});

// ---------------------------------------------------------------- #6 / #10 route wiring

test("P6-2 #6/#10: account-lines route validates the uuid; export-statements requires download MFA", () => {
  const route = readFileSync(path.join(process.cwd(), "src/app/api/books/[...path]/route.ts"), "utf8");
  const lines = route.slice(
    route.indexOf('path[1] === "account-lines"'),
    route.indexOf('path[1] === "entry-source"'),
  );
  assert.match(lines, /assertUuid\(accountId/);
  const exp = route.slice(route.indexOf('path[1] === "export-statements"'));
  const mfaAt = exp.search(/assertDownloadMfa\(session\.userId, await mfaTokenFromRequest\(\)\)/);
  const exportAt = exp.indexOf("exportBooksFinancialStatements(");
  assert.ok(mfaAt > 0, "export-statements calls assertDownloadMfa");
  assert.ok(mfaAt < exportAt, "MFA checked before the export is built");
  assert.match(route, /jar\.get\(MFA_COOKIE\)/, "token read from the MFA cookie");
});
