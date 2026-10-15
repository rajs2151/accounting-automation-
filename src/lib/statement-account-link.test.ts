import assert from "node:assert/strict";
import test from "node:test";

import { resolveStatementAccountLink } from "@/lib/statement-account-link";

test("C2-2: match intended IBAN links that account", () => {
  const r = resolveStatementAccountLink({
    extractedIban: "AE07 0331 2345 6789 0123 456",
    intendedAccountId: "acc-a",
    intendedAccountIban: "AE070331234567890123456",
  });
  assert.equal(r.accountId, "acc-a");
  assert.deepEqual(r.flags, []);
  assert.equal(r.forceNeedsReview, false);
});

test("C2-2: IBAN ≠ selected account blocks intended link and flags mismatch", () => {
  const r = resolveStatementAccountLink({
    extractedIban: "AE110331000000000000001",
    intendedAccountId: "acc-a",
    intendedAccountIban: "AE070331234567890123456",
    accountIdByIban: new Map([["AE110331000000000000001", "acc-b"]]),
  });
  assert.equal(r.accountId, "acc-b");
  assert.ok(r.flags.includes("iban_account_mismatch"));
  assert.equal(r.forceNeedsReview, true);
});

test("C2-2: mismatch with no other COA match leaves account_id null", () => {
  const r = resolveStatementAccountLink({
    extractedIban: "AE990000000000000000099",
    intendedAccountId: "acc-a",
    intendedAccountIban: "AE070331234567890123456",
  });
  assert.equal(r.accountId, null);
  assert.ok(r.flags.includes("iban_account_mismatch"));
  assert.equal(r.forceNeedsReview, true);
});

test("C2-2: selected account has IBAN but file has none → missing flag", () => {
  const r = resolveStatementAccountLink({
    extractedIban: null,
    intendedAccountId: "acc-a",
    intendedAccountIban: "AE070331234567890123456",
  });
  assert.equal(r.accountId, null);
  assert.ok(r.flags.includes("iban_missing_for_selected_account"));
  assert.equal(r.forceNeedsReview, true);
});

test("C2-2: cash/gateway no IBAN on either side links intended", () => {
  const r = resolveStatementAccountLink({
    extractedIban: null,
    intendedAccountId: "acc-cash",
    intendedAccountIban: null,
  });
  assert.equal(r.accountId, "acc-cash");
  assert.deepEqual(r.flags, []);
});

test("C2-2: header upload (no intended) soft-links by unique IBAN", () => {
  const r = resolveStatementAccountLink({
    extractedIban: "AE07 0331 2345 6789 0123 456",
    accountIdByIban: { AE070331234567890123456: "acc-a" },
  });
  assert.equal(r.accountId, "acc-a");
  assert.equal(r.forceNeedsReview, false);
});
