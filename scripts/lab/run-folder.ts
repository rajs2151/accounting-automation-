/**
 * Local real-data lab (not product). Runs pipeline detection against a throwaway schema.
 *
 * Usage:
 *   npx tsx scripts/lab/run-folder.ts --input <folder> --period YYYY-MM [--client-trn ...]
 *
 * Writes gitignored lab-output/<timestamp>/report.json then drops the lab schema.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { detectDocTypeFromName } from "../../src/server/inbox-route";

function arg(name: string) {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

const input = arg("--input");
const period = arg("--period");
const clientTrn = arg("--client-trn");

if (!input || !period) {
  console.error("Usage: npx tsx scripts/lab/run-folder.ts --input <folder> --period YYYY-MM [--client-trn ...]");
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(ROOT, "lab-output", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(outDir, { recursive: true });

const schema = `lab_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const adminUrl =
  process.env.DATABASE_URL_SUPER ||
  process.env.DATABASE_URL?.replace("://daftar_app:", "://daftar:") ||
  "postgresql://daftar:daftar-local-only@127.0.0.1:5432/daftar";

const admin = new pg.Client({ connectionString: adminUrl });

type FileReport = {
  name: string;
  sha256: string;
  detectedDocType: string;
  confidence: number;
  skipped?: string;
};

async function main() {
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const report = {
    schema,
    period,
    clientTrn: clientTrn || null,
    input,
    files: [] as FileReport[],
    assumptions: [
      "OCR limited to local Tesseract when used by product parsers; this lab only sniffs filenames.",
      "Throwaway schema holds no tenant data; product PORTAL_SECURITY_STATUS remains FAIL.",
      "Results are written under lab-output/ (gitignored).",
    ],
    unmatchedItems: [] as string[],
    missingDocs: [] as string[],
  };

  try {
    const entries = readdirSync(input!);
    for (const name of entries) {
      const full = path.join(input!, name);
      if (!statSync(full).isFile()) continue;
      const content = readFileSync(full);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const detected = detectDocTypeFromName(name);
      const row: FileReport = {
        name,
        sha256,
        detectedDocType: detected.docType,
        confidence: detected.confidence,
      };
      if (detected.confidence < 40) {
        row.skipped = "low_confidence_type";
        report.unmatchedItems.push(name);
      }
      if (clientTrn && !name.includes(clientTrn) && detected.confidence < 80) {
        report.missingDocs.push(`Could not bind ${name} to TRN ${clientTrn}`);
      }
      report.files.push(row);
      await admin.query(`CREATE TABLE IF NOT EXISTS ${schema}.lab_files (name text, sha256 text, doc_type text)`);
      await admin.query(`INSERT INTO ${schema}.lab_files(name, sha256, doc_type) VALUES ($1,$2,$3)`, [
        name,
        sha256,
        detected.docType,
      ]);
    }

    writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
    console.log(`Lab report: ${path.join(outDir, "report.json")}`);
    console.log(`Files: ${report.files.length}; unmatched: ${report.unmatchedItems.length}`);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
