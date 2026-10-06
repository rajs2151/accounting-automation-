/**
 * VAT 201 return helpers (P2B-6 box mapping; P2B-7 draft generation).
 * Box map lives in books_vat_codes.vat201_output_box / vat201_input_box (db/54); emirate letters for
 * Box 1 come from the document's place of supply (P2B-5).
 */
import type { PlaceOfSupply } from "@/server/books/place-of-supply";

/** Box 1 sub-box per emirate (VAT 201 form order). */
export const EMIRATE_BOX: Record<Exclude<PlaceOfSupply, "OUTSIDE_UAE">, string> = {
  "Abu Dhabi": "1a",
  Dubai: "1b",
  Sharjah: "1c",
  Ajman: "1d",
  "Umm Al Quwain": "1e",
  "Ras Al Khaimah": "1f",
  Fujairah: "1g",
};

export type VatBoxMapRow = {
  code: string;
  vat201OutputBox: string | null;
  vat201InputBox: string | null;
};

/**
 * Box for a VAT code in a direction. Output Box 1 needs an emirate (→ 1a–1g); without one the line
 * cannot be placed and the caller must treat it as a gap. Returns null when the code reports nowhere.
 */
export function vat201Box(
  map: ReadonlyMap<string, VatBoxMapRow>,
  code: string | null | undefined,
  direction: "output" | "input",
  placeOfSupply?: PlaceOfSupply | null,
): { box: string | null; needsEmirate: boolean } {
  if (!code) return { box: null, needsEmirate: false };
  const row = map.get(code);
  if (!row) return { box: null, needsEmirate: false };
  const box = direction === "output" ? row.vat201OutputBox : row.vat201InputBox;
  if (box !== "1") return { box, needsEmirate: false };
  if (!placeOfSupply || placeOfSupply === "OUTSIDE_UAE") return { box: null, needsEmirate: true };
  return { box: EMIRATE_BOX[placeOfSupply], needsEmirate: false };
}
