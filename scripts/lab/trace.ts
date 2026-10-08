/**
 * Read-only document / inbox / bank-txn provenance (ING-5b).
 *
 * Usage (repo root, local DB env):
 *   npm run trace -- INV-ING5-001
 *   npm run trace -- <uuid>
 *
 * Never writes. Prints the same chain as GET /api/books/trace.
 */
import pg from "pg";

import {
  traceBooksBankTransaction,
  traceBooksDocument,
  type TraceResult,
} from "../../src/server/books/trace";

const OMAR = "55555555-5555-4555-8555-555555555555";

function arg(): string | undefined {
  const a = process.argv.slice(2).filter((x) => !x.startsWith("-"));
  return a[0];
}

function printTrace(t: TraceResult) {
  console.log(`\nTrace · ${t.kind} · ${t.title} (${t.id})`);
  console.log("─".repeat(60));
  for (const s of t.steps) {
    const mark = s.status === "done" ? "✓" : s.status === "failed" ? "✗" : "·";
    const who = s.actors.map((a) => a.name || a.id.slice(0, 8)).join(", ");
    console.log(`${mark} ${s.label} [${s.status}]${who ? ` — ${who}` : ""}`);
    if (typeof s.detail.note === "string") console.log(`    ${s.detail.note}`);
    if (s.key === "journal" && Array.isArray(s.detail.lines)) {
      for (const l of s.detail.lines as Array<{
        code: string;
        debitMinor: number;
        creditMinor: number;
      }>) {
        console.log(
          `    ${l.code}  Dr ${l.debitMinor || 0}  Cr ${l.creditMinor || 0}`,
        );
      }
    }
    if (s.key === "open_item" && s.detail.openAedMinor != null) {
      console.log(
        `    open AED ${s.detail.openAedMinor} / original ${s.detail.openOriginalMinor}`,
      );
    }
  }
  console.log("\nTie-outs");
  for (const tOut of t.tieOuts) {
    const mark = tOut.ok === true ? "✓" : tOut.ok === false ? "✗" : "·";
    console.log(`${mark} ${tOut.label}${tOut.detail ? ` — ${tOut.detail}` : ""}`);
  }
  if (t.reportEffects.length) {
    console.log("\nReport effects");
    for (const e of t.reportEffects) {
      console.log(`  ${e.label}: ${e.amountMinor}`);
    }
  }
}

async function main() {
  const key = arg();
  if (!key) {
    console.error("Usage: npm run trace -- <documentNo|inboxId|bankTxnId>");
    process.exit(2);
  }

  const appUrl =
    process.env.DATABASE_URL ||
    "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar";
  process.env.DATABASE_URL = appUrl;

  const adminUrl =
    process.env.DATABASE_URL_SUPER || appUrl.replace("://daftar_app:", "://daftar:");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();

  try {
    // Prefer active synthetic client that owns this key when possible.
    const clients = await admin.query(
      `SELECT id FROM clients WHERE is_synthetic = true ORDER BY created_at DESC LIMIT 20`,
    );
    if (!clients.rowCount) {
      console.error("No synthetic client found.");
      process.exit(1);
    }

    let lastErr: unknown = null;
    for (const c of clients.rows) {
      const clientId = String(c.id);
      try {
        const bank = await admin.query(
          `SELECT id FROM books_bank_transactions WHERE id::text = $1 AND client_id = $2`,
          [key, clientId],
        );
        if (bank.rowCount) {
          printTrace(await traceBooksBankTransaction(OMAR, clientId, key));
          return;
        }
        printTrace(await traceBooksDocument(OMAR, clientId, key));
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    console.error(lastErr instanceof Error ? lastErr.message : lastErr);
    process.exit(1);
  } finally {
    await admin.end().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
