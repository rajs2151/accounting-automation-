/**
 * Compare extracted party fields from an inbox review against the selected master party.
 * Used for the C1 party-mismatch banner (name / TRN only — address later).
 */

export type ExtractedPartyFields = {
  name?: string | null;
  trn?: string | null;
};

export type MasterPartyFields = {
  id: string;
  name: string;
  trn?: string | null;
};

export type PartyFieldDiff = {
  field: "name" | "trn";
  extracted: string;
  master: string;
};

function normName(s: string | null | undefined): string {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normTrn(s: string | null | undefined): string {
  return String(s || "").replace(/[\s-]/g, "");
}

/** True when extraction has a name or TRN we can compare. */
export function hasExtractedPartySignal(extracted: ExtractedPartyFields): boolean {
  return Boolean(normName(extracted.name) || normTrn(extracted.trn));
}

/**
 * Diffs where both sides have a value and they differ.
 * Missing on one side is not a mismatch (accountant may still be filling the master).
 */
export function partyMismatchDiffs(
  extracted: ExtractedPartyFields,
  master: MasterPartyFields | null | undefined,
): PartyFieldDiff[] {
  if (!master) return [];
  const diffs: PartyFieldDiff[] = [];
  const eName = normName(extracted.name);
  const mName = normName(master.name);
  if (eName && mName && eName !== mName) {
    diffs.push({
      field: "name",
      extracted: String(extracted.name || "").trim(),
      master: master.name,
    });
  }
  const eTrn = normTrn(extracted.trn);
  const mTrn = normTrn(master.trn);
  if (eTrn && mTrn && eTrn !== mTrn) {
    diffs.push({
      field: "trn",
      extracted: eTrn,
      master: mTrn,
    });
  }
  return diffs;
}
