import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { buildXlsx } from "@/server/books/xlsx";

test("RPT-1: XLSX export is a valid workbook with numeric amounts and escaped text", () => {
  const rows = [
    ["Trial balance"],
    ["Test Co <Synthetic> & Sons"],
    [],
    ["Particulars", "Debit", "Credit"],
    ["  1120 Bank", "1550.00", ""],
    ["Grand total", "1550.00", "1550.00"],
    ["Difference", "-0.10", ""],
  ];
  const buf = buildXlsx(rows, "Trial balance");
  const dir = mkdtempSync(path.join(tmpdir(), "rpt1-xlsx-"));
  const file = path.join(dir, "tb.xlsx");
  writeFileSync(file, buf);
  // Read back with Python's zipfile + XML parser (independent of our writer).
  const out = execFileSync(
    "python3",
    [
      "-I",
      "-c",
      [
        "import sys, zipfile, json, xml.etree.ElementTree as ET",
        "z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None",
        "ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}",
        "wb = ET.fromstring(z.read('xl/workbook.xml'))",
        "sh = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))",
        "cells = {}",
        "for c in sh.iter('{%s}c' % ns['m']):",
        "    v = c.find('m:v', ns); t = c.find('m:is/m:t', ns)",
        "    cells[c.get('r')] = ('n', v.text) if v is not None else ('s', t.text)",
        "print(json.dumps({'names': sorted(z.namelist()), 'sheet': wb.find('m:sheets/m:sheet', ns).get('name'), 'cells': cells}))",
      ].join("\n"),
      file,
    ],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(out) as { names: string[]; sheet: string; cells: Record<string, [string, string]> };
  assert.deepEqual(parsed.names, [
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/_rels/workbook.xml.rels",
    "xl/workbook.xml",
    "xl/worksheets/sheet1.xml",
  ]);
  assert.equal(parsed.sheet, "Trial balance");
  assert.deepEqual(parsed.cells.A2, ["s", "Test Co <Synthetic> & Sons"]);
  assert.deepEqual(parsed.cells.B5, ["n", "1550.00"]);
  assert.deepEqual(parsed.cells.C6, ["n", "1550.00"], "grand total exported as a number");
  assert.deepEqual(parsed.cells.B7, ["n", "-0.10"]);
  assert.equal(parsed.cells.C5, undefined, "zero / blank cells stay empty");
});
