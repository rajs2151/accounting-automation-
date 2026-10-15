/**
 * Local diagnostic for one bill/statement (never commit output).
 *
 * Usage:
 *   npm run lab:extract-one -- --file real-docs/inv.pdf [--company-trn ...] [--company-name ...]
 *
 * Writes lab-out/<timestamp>/<basename>.json (gitignored).
 */
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

const file = arg("--file");
if (!file) {
  console.error(
    "Usage: npm run lab:extract-one -- --file <path> [--company-trn TRN] [--company-name Name]",
  );
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
if (!existsSync(abs)) {
  console.error(`File not found: ${abs}`);
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const base = path.basename(abs).replace(/[^\w.-]+/g, "_");
const outDir = path.join(ROOT, "lab-out", stamp);
mkdirSync(outDir, { recursive: true });
const outJson = path.join(outDir, `${base}.json`);

const inner = path.join(ROOT, "scripts/lab/extract_one_inner.py");
const pyArgs = [
  inner,
  "--file",
  abs,
  "--out",
  outJson,
];
const trn = arg("--company-trn");
const name = arg("--company-name");
if (trn) pyArgs.push("--company-trn", trn);
if (name) pyArgs.push("--company-name", name);

const env = {
  ...process.env,
  PYTHONPATH: [path.join(ROOT, "worker/src"), process.env.PYTHONPATH || ""]
    .filter(Boolean)
    .join(path.delimiter),
};

const result = spawnSync("python", pyArgs, {
  cwd: ROOT,
  env,
  encoding: "utf-8",
  maxBuffer: 20 * 1024 * 1024,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) {
  console.error(`extract-one failed (exit ${result.status}). Is Python + worker deps installed?`);
  process.exit(result.status ?? 1);
}
console.error(`Wrote ${outJson}`);
