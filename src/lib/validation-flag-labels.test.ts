import assert from "node:assert/strict";
import test from "node:test";

import { splitValidationFlags } from "@/lib/validation-flag-labels";

test("readable badges for common extraction flags", () => {
  const { badges, technical } = splitValidationFlags([
    "tax_invoice",
    "methods:1:doctr",
    "company_match:mismatch",
    "unassigned",
  ]);
  assert.deepEqual(
    badges.map((b) => b.label),
    ["Tax invoice", "Company mismatch", "Unassigned"],
  );
  assert.deepEqual(technical, ["methods:1:doctr"]);
});

test("vat_code_missing and party_roles_uncertain stay readable", () => {
  const { badges, technical } = splitValidationFlags([
    "vat_code_missing",
    "party_roles_uncertain",
  ]);
  assert.equal(badges.length, 2);
  assert.equal(technical.length, 0);
  assert.ok(badges.some((b) => b.label === "VAT code missing"));
  assert.ok(badges.some((b) => b.label === "Party roles uncertain"));
});

test("ING-4d: expected vs read on failed check flags", () => {
  const { badges, technical } = splitValidationFlags([
    "totals_mismatch:expected=10500|got=12000",
    "balance_diff:1500",
    "methods:1:pdf_text",
  ]);
  assert.equal(technical.length, 2);
  assert.equal(badges.length, 1);
  assert.match(badges[0]!.label, /expected 105\.00/i);
  assert.match(badges[0]!.label, /read 120\.00/i);
  assert.equal(badges[0]!.expected, "105.00");
  assert.equal(badges[0]!.got, "120.00");
});
