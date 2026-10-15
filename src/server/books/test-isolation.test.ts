/**
 * Guard: writer tests must not hard-code DESERT's id (parallel pollution).
 * Allow-list = read-only goldens only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// Assembled so this guard file itself does not contain the literal UUID.
const DESERT_ID = ["e1000001", "0000", "4000", "8000", "000000000001"].join("-");

/** Files still allowed to reference DESERT (read-only goldens). */
const ALLOW_LIST = new Set([
  "trial-balance.test.ts",
  "company-a-golden.test.ts",
]);

function walkTestFiles(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === ".next") continue;
      walkTestFiles(full, out);
    } else if (ent.isFile() && ent.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

test("TEST-ISO-1 guard: only allow-listed tests reference DESERT id", () => {
  const srcRoot = path.join(process.cwd(), "src");
  const offenders: string[] = [];
  for (const file of walkTestFiles(srcRoot)) {
    const base = path.basename(file);
    if (ALLOW_LIST.has(base)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (text.includes(DESERT_ID)) {
      offenders.push(path.relative(process.cwd(), file).replace(/\\/g, "/"));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Non-allow-listed test files reference DESERT (${DESERT_ID}):\n${offenders.join("\n")}`,
  );
});
