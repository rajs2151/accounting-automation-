import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AL_NOOR = "22222222-2222-4222-8222-222222222222";
const NORTHWIND = "77777777-7777-4777-8777-777777777777";
const OMAR = "55555555-5555-4555-8555-555555555555";
const FILE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STATEMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KNOWN_TXN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const PAGE_WIDTH = 640;
const PAGE_HEIGHT = 800;
const BBOX = { x: 48, y: 120, width: 520, height: 48, pageWidth: PAGE_WIDTH, pageHeight: PAGE_HEIGHT };

const PGHOST = process.env.PGHOST || "127.0.0.1";

function psql(database, args) {
  execFileSync("psql", ["-h", PGHOST, "-U", "daftar", "-d", database, "-v", "ON_ERROR_STOP=1", ...args], {
    env: { ...process.env, PGPASSWORD: "daftar-local-only" },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

function pagePng() {
  const stride = PAGE_WIDTH * 3 + 1;
  const raw = Buffer.alloc(stride * PAGE_HEIGHT);
  for (let y = 0; y < PAGE_HEIGHT; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < PAGE_WIDTH; x++) {
      const marked = x >= BBOX.x && x < BBOX.x + BBOX.width && y >= BBOX.y && y < BBOX.y + BBOX.height;
      const i = row + 1 + x * 3;
      raw[i] = marked ? 232 : 244;
      raw[i + 1] = marked ? 168 : 236;
      raw[i + 2] = marked ? 74 : 220;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(PAGE_WIDTH, 0);
  ihdr.writeUInt32BE(PAGE_HEIGHT, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export default async function globalSetup() {
  psql("postgres", ["-c", "SELECT 1 FROM pg_database WHERE datname = 'daftar_e2e'"]);
  const exists = execFileSync(
    "psql",
    ["-h", PGHOST, "-U", "daftar", "-d", "postgres", "-tAc", "SELECT 1 FROM pg_database WHERE datname = 'daftar_e2e'"],
    { env: { ...process.env, PGPASSWORD: "daftar-local-only" }, encoding: "utf8" },
  ).trim();
  if (exists !== "1") {
    psql("postgres", ["-c", "CREATE DATABASE daftar_e2e OWNER daftar"]);
  }
  psql("daftar_e2e", ["-c", "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO daftar; GRANT ALL ON SCHEMA public TO public;"]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/01-schema.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/02-seed.sql")]);
  // Portal security gate adds clients.is_synthetic; API context() reads it on every authed call.
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/12-security.sql")]);
  // Stage G pipeline tables (inbox / profile). Ledger seed not required for grid scroll.
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/04-ledger.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/05-ledger-seed.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/13-pipeline.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/14-pipeline-seed.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/15-pipeline-demo.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/16-books.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/17-books-seed.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/18-books-phase0.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/19-books-demo-journals.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/20-books-coa-v2.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/21-books-phase0-fixes.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/22-books-alignment.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/23-books-phase1.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/24-books-phase1-seed.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/25-books-slice1.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/26-books-approver-release-rls.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/27-books-approver-least-privilege.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/28-books-c1-printed-totals.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/29-books-c1-check-vat.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/30-pytest0-force-rls-reference.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/31-demo-owner-user.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/32-books-files-hash-per-company.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/33-books-c2-bank-accounts.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/34-books-c2-intended-account.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/35-books-c3-bank-transactions.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/36-books-c3-bank-txn-match.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/37-books-c3-transfer-link.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/38-books-p2a-bank-txn-allocations.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/39-books-p2a-match-suggestions.sql")]);
  psql("daftar_e2e", ["-f", path.join(ROOT, "db/40-books-p2a-bank-rules.sql")]);

  const admin = new pg.Client({
    connectionString:
      process.env.DATABASE_URL_SUPER ||
      `postgresql://daftar:daftar-local-only@${PGHOST}:5432/daftar_e2e`,
  });
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO files (id, client_id, sha256, original_name, detected_mime, size, storage_key, uploaded_by)
       VALUES ($1,$2,$3,'volume.csv','text/csv',1,'e2e/volume.csv',$4)`,
      [FILE_ID, AL_NOOR, FILE_ID, OMAR],
    );
    await admin.query(
      `INSERT INTO statements (id, client_id, bank_account_id, file_id, currency, status)
       VALUES ($1,$2,$3,$4,'AED','parsed')`,
      [STATEMENT_ID, AL_NOOR, NORTHWIND, FILE_ID],
    );
    await admin.query(
      `INSERT INTO bank_transactions (
         client_id, statement_id, row_no, txn_date, description_raw, description_clean,
         debit_minor, balance_minor, currency, txn_type, dedupe_hash, reference, flags
       )
       SELECT $1, $2, g, DATE '2010-01-01' + ((g - 1) * INTERVAL '1 day'),
              'VOLUME', 'VOLUME', 100, 100, 'AED', 'debit', 'vol-' || g::text,
              'V' || lpad(g::text, 5, '0'), '{volume}'
       FROM generate_series(1, 50000) AS g`,
      [AL_NOOR, STATEMENT_ID],
    );
    await admin.query(
      `UPDATE bank_transactions
       SET id = $3,
           reference = 'KNOWN-SOURCE',
           description_raw = 'KNOWN-SOURCE row',
           description_clean = 'KNOWN-SOURCE row',
           source_page = 1,
           source_bbox = $4::jsonb
       WHERE statement_id = $1 AND row_no = $2`,
      [STATEMENT_ID, 24000, KNOWN_TXN, JSON.stringify(BBOX)],
    );
    await admin.query(
      `INSERT INTO statement_pages (client_id, statement_id, page_no, storage_key, width, height)
       VALUES ($1,$2,1,'e2e/known-page.png',$3,$4)`,
      [AL_NOOR, STATEMENT_ID, PAGE_WIDTH, PAGE_HEIGHT],
    );
  } finally {
    await admin.end();
  }

  const endpoint = process.env.S3_ENDPOINT || "http://127.0.0.1:59000";
  const bucket = process.env.S3_BUCKET || "statements";
  const s3 = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY || "daftar",
      secretAccessKey: process.env.S3_SECRET_KEY || "daftar-local-only",
    },
  });
  await s3.send(new CreateBucketCommand({ Bucket: bucket })).catch((error) => {
    if (error.name !== "BucketAlreadyOwnedByYou" && error.name !== "BucketAlreadyExists") throw error;
  });
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "e2e/known-page.png",
      Body: pagePng(),
      ContentType: "image/png",
    }),
  );

  const artifacts = path.join(ROOT, "e2e/artifacts");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(path.join(artifacts, "known-row.json"), JSON.stringify({ id: KNOWN_TXN, reference: "KNOWN-SOURCE" }, null, 2));
}

if (process.argv[1]?.includes("global-setup")) {
  globalSetup().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
