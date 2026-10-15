/** Addendum A §3 parsing helpers — integer fils, no floats. */

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_ARABIC = "۰۱۲۳۴۵۶۷۸۹";

export function arabicIndicToAscii(input: string): string {
  let out = "";
  for (const ch of input) {
    const i1 = ARABIC_INDIC.indexOf(ch);
    if (i1 >= 0) {
      out += String(i1);
      continue;
    }
    const i2 = EASTERN_ARABIC.indexOf(ch);
    if (i2 >= 0) {
      out += String(i2);
      continue;
    }
    out += ch;
  }
  return out;
}

/** Parse amount strings to signed integer fils. */
export function parseAmountToFils(raw: string): number {
  let s = arabicIndicToAscii(raw).trim();
  if (!s) throw new Error("invalid_amount");
  let sign = 1;
  if (s.startsWith("(") && s.endsWith(")")) {
    sign = -1;
    s = s.slice(1, -1).trim();
  }
  if (/[Dd]r\s*$/.test(s)) {
    s = s.replace(/[Dd]r\s*$/, "").trim();
  }
  if (/[Cc]r\s*$/.test(s)) {
    sign = -sign;
    s = s.replace(/[Cc]r\s*$/, "").trim();
  }
  s = s.replace(/^(AED|USD|EUR|GBP)\s*/i, "");
  if (s.startsWith("-")) {
    sign = -sign;
    s = s.slice(1).trim();
  }
  // European 1.234,56 vs 1,234.56
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error("invalid_amount");
  const [whole, frac = ""] = s.split(".");
  const fils = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(fils)) throw new Error("invalid_amount");
  return sign * fils;
}

export type DateFormatHint = "dd/mm/yyyy" | "mm/dd/yyyy" | "yyyy-mm-dd" | "auto";

export function parseDateUae(
  raw: string,
  hint: DateFormatHint = "dd/mm/yyyy",
  periodFrom?: string,
  periodTo?: string,
): string {
  const s = arabicIndicToAscii(raw).trim();
  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  let y: number, m: number, d: number;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    y = Number(iso[1]);
    m = Number(iso[2]);
    d = Number(iso[3]);
  } else {
    const named = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
    if (named) {
      d = Number(named[1]);
      m = months[named[2].slice(0, 3).toLowerCase()];
      y = Number(named[3]);
      if (!m) throw new Error("invalid_date");
    } else {
      const slash = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
      if (!slash) throw new Error("invalid_date");
      const a = Number(slash[1]);
      const b = Number(slash[2]);
      y = Number(slash[3]);
      if (hint === "mm/dd/yyyy") {
        m = a;
        d = b;
      } else if (hint === "dd/mm/yyyy") {
        d = a;
        m = b;
      } else {
        // auto: prefer dd/mm; if invalid and mm/dd valid, use that; use period to disambiguate
        if (a > 12) {
          d = a;
          m = b;
        } else if (b > 12) {
          m = a;
          d = b;
        } else {
          d = a;
          m = b;
          const candidate = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          if (periodFrom && periodTo && (candidate < periodFrom || candidate > periodTo)) {
            m = a;
            d = b;
          }
        }
      }
    }
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error("invalid_date");
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** UAE TRN: 15 digits starting with 100 */
export function isValidTrn(trn: string | null | undefined): boolean {
  if (!trn) return false;
  return /^100\d{12}$/.test(trn.replace(/\s/g, ""));
}

/** IBAN mod-97 */
export function isValidIban(iban: string | null | undefined): boolean {
  if (!iban) return false;
  const cleaned = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(cleaned) || cleaned.length < 15) return false;
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);
  let expanded = "";
  for (const ch of rearranged) {
    if (ch >= "A" && ch <= "Z") expanded += String(ch.charCodeAt(0) - 55);
    else expanded += ch;
  }
  let remainder = 0;
  for (const ch of expanded) {
    remainder = (remainder * 10 + Number(ch)) % 97;
  }
  return remainder === 1;
}

export const FREE_ZONE_EMIRATE_DEFAULTS: Record<string, string> = {
  Meydan: "Dubai",
  RAKEZ: "Ras Al Khaimah",
  IFZA: "Dubai",
  DMCC: "Dubai",
  DSO: "Dubai",
  JAFZA: "Dubai",
  "SPC Free Zone": "Sharjah",
};

export function emirateForFreeZone(zone: string): string | null {
  return FREE_ZONE_EMIRATE_DEFAULTS[zone] ?? null;
}
