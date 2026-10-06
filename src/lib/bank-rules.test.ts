import assert from "node:assert/strict";
import test from "node:test";

import { bankRuleMatches, pickBankRule } from "@/lib/bank-rules";

test("P2A-3: rule matches counterparty + direction + amount", () => {
  const rule = {
    counterpartyContains: "stripe",
    direction: "in" as const,
    amountMinMinor: 1000,
    amountMaxMinor: 50000,
  };
  assert.equal(
    bankRuleMatches(rule, {
      accountId: "a",
      description: "STRIPE PAYOUT",
      debitMinor: 0,
      creditMinor: 25000,
    }),
    true,
  );
  assert.equal(
    bankRuleMatches(rule, {
      accountId: "a",
      description: "STRIPE PAYOUT",
      debitMinor: 25000,
      creditMinor: 0,
    }),
    false,
  );
});

test("P2A-3: pickBankRule uses priority", () => {
  const rules = [
    {
      id: "1",
      name: "Low",
      priority: 200,
      active: true,
      counterpartyContains: "fee",
      setTxnType: "bank_charge",
    },
    {
      id: "2",
      name: "High",
      priority: 10,
      active: true,
      counterpartyContains: "fee",
      setTxnType: "other_expense",
    },
  ];
  const picked = pickBankRule(rules, {
    accountId: "a",
    description: "Bank fee monthly",
    debitMinor: 100,
    creditMinor: 0,
  });
  assert.equal(picked?.id, "2");
  assert.equal(picked?.name, "High");
});
