export type StatusTone = "neutral" | "warning" | "info" | "success" | "danger";

export type StatusLabel = {
  label: string;
  tone: StatusTone;
};

const INBOX: Record<string, StatusLabel> = {
  queued: { label: "Queued", tone: "neutral" },
  extracting: { label: "Extracting", tone: "warning" },
  needs_review: { label: "Needs review", tone: "warning" },
  ready: { label: "Ready", tone: "info" },
  confirmed: { label: "Confirmed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  routed: { label: "Routed", tone: "neutral" },
  duplicate: { label: "Duplicate", tone: "neutral" },
};

const DOCUMENT: Record<string, StatusLabel> = {
  draft: { label: "Draft", tone: "neutral" },
  approved: { label: "Approved", tone: "success" },
  posted: { label: "Posted", tone: "success" },
  partially_paid: { label: "Partially paid", tone: "info" },
  paid: { label: "Paid", tone: "success" },
  void: { label: "Void", tone: "neutral" },
};

const EXTRACTION: Record<string, StatusLabel> = {
  ready: { label: "Ready", tone: "info" },
  needs_review: { label: "Needs review", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
};

const STATEMENT: Record<string, StatusLabel> = {
  ready: { label: "Extracted", tone: "info" },
  needs_review: { label: "Needs review", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  confirmed: { label: "Confirmed", tone: "success" },
  queued: { label: "Queued", tone: "neutral" },
  extracting: { label: "Extracting", tone: "warning" },
};

const BALANCE: Record<string, StatusLabel> = {
  ok: { label: "Balanced", tone: "success" },
  failed: { label: "Off balance", tone: "danger" },
};

const DOC_TYPE: Record<string, StatusLabel> = {
  sales_invoice: { label: "Sales invoice", tone: "info" },
  purchase_bill: { label: "Purchase bill", tone: "info" },
  credit_note: { label: "Credit note", tone: "neutral" },
  debit_note: { label: "Debit note", tone: "neutral" },
  receipt: { label: "Receipt", tone: "neutral" },
  payment: { label: "Payment", tone: "neutral" },
  contra: { label: "Contra", tone: "neutral" },
  opening: { label: "Opening", tone: "neutral" },
  bank_statement: { label: "Bank statement", tone: "info" },
  card_statement: { label: "Card statement", tone: "info" },
  gateway_statement: { label: "Gateway statement", tone: "info" },
  trial_balance: { label: "Trial balance", tone: "info" },
};

export function inboxStatusLabel(status: string, duplicate?: boolean): StatusLabel {
  if (duplicate) return INBOX.duplicate!;
  return INBOX[status] || { label: status, tone: "neutral" };
}

export function documentStatusLabel(status: string): StatusLabel {
  return DOCUMENT[status] || { label: status, tone: "neutral" };
}

export function extractionStatusLabel(status: string): StatusLabel {
  return EXTRACTION[status] || { label: status, tone: "neutral" };
}

export function statementStatusLabel(status: string): StatusLabel {
  return STATEMENT[status] || { label: status, tone: "neutral" };
}

export function balanceCheckLabel(check: string): StatusLabel {
  return BALANCE[check] || { label: check, tone: "neutral" };
}

export function docTypeLabel(type: string | null | undefined): StatusLabel {
  if (!type) return { label: "—", tone: "neutral" };
  return DOC_TYPE[type] || { label: type, tone: "neutral" };
}

/** Every status key the server can emit (for unit tests). */
export const ALL_KNOWN_STATUS_KEYS = [
  ...Object.keys(INBOX),
  ...Object.keys(DOCUMENT),
  ...Object.keys(EXTRACTION),
  ...Object.keys(STATEMENT),
  ...Object.keys(BALANCE),
] as const;
