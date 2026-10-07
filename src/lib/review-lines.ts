/** Review line-item normalisation — missing money stays null (never invent 0.00). */

export type ReviewLineInput = {
  description?: string;
  vatCode?: string | null;
  vat_code?: string | null;
  netMinor?: number | null;
  amount_minor?: number | null;
  vatMinor?: number | null;
};

export type ReviewLine = {
  description: string;
  vatCode: string;
  netMinor: number | null;
  vatMinor: number | null;
};

export const REVIEW_EMPTY_FIELD = "Not found — enter it";

function optionalMinor(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeReviewLines(items: ReviewLineInput[] | null | undefined): ReviewLine[] {
  return (items || []).map((l) => {
    const raw = l.vatCode ?? l.vat_code ?? null;
    const code = raw == null || String(raw).trim() === "" ? "" : String(raw).trim();
    const desc = String(l.description || "").trim();
    return {
      // Never use the upload file name as the line description.
      description: desc && !/\.(pdf|png|jpe?g|heic|xlsx?|csv)$/i.test(desc) ? desc : "",
      vatCode: code,
      netMinor: optionalMinor(l.netMinor ?? l.amount_minor),
      vatMinor: optionalMinor(l.vatMinor),
    };
  });
}
