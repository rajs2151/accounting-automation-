/** Pure bank-rule matching (P2A-3). */

export type BankRuleCondition = {
  counterpartyContains?: string | null;
  narrationRegex?: string | null;
  amountMinMinor?: number | null;
  amountMaxMinor?: number | null;
  accountId?: string | null;
  direction?: "in" | "out" | null;
};

export type BankRuleAction = {
  setTxnType?: string | null;
  setCategoryAccountId?: string | null;
  setVatCode?: string | null;
  setTags?: string[];
  setCounterparty?: string | null;
};

export type BankRuleDef = BankRuleCondition &
  BankRuleAction & {
    id: string;
    name: string;
    priority: number;
    active: boolean;
  };

export type BankRuleTxnProbe = {
  accountId: string;
  description: string;
  reference?: string | null;
  debitMinor: number;
  creditMinor: number;
};

export function bankRuleMatches(rule: BankRuleCondition, txn: BankRuleTxnProbe): boolean {
  const amount = Math.max(txn.debitMinor, txn.creditMinor);
  const direction: "in" | "out" | null =
    txn.creditMinor > 0 ? "in" : txn.debitMinor > 0 ? "out" : null;
  const text = `${txn.description || ""} ${txn.reference || ""}`.toLowerCase();

  if (rule.accountId && rule.accountId !== txn.accountId) return false;
  if (rule.direction && rule.direction !== direction) return false;
  if (rule.amountMinMinor != null && amount < rule.amountMinMinor) return false;
  if (rule.amountMaxMinor != null && amount > rule.amountMaxMinor) return false;
  if (rule.counterpartyContains) {
    const needle = rule.counterpartyContains.toLowerCase().trim();
    if (!needle || !text.includes(needle)) return false;
  }
  if (rule.narrationRegex) {
    try {
      const re = new RegExp(rule.narrationRegex, "i");
      if (!re.test(`${txn.description || ""} ${txn.reference || ""}`)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** First active rule by priority (lower wins). */
export function pickBankRule(rules: BankRuleDef[], txn: BankRuleTxnProbe): BankRuleDef | null {
  const active = rules.filter((r) => r.active).sort((a, b) => a.priority - b.priority);
  for (const r of active) {
    if (bankRuleMatches(r, txn)) return r;
  }
  return null;
}
