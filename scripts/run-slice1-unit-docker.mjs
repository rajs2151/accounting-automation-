import { spawnSync } from "node:child_process";
import fs from "node:fs";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

process.env.PGPASSWORD = process.env.PGPASSWORD || "daftar-local-only";
for (const f of fs.readdirSync("/work/db").filter((n) => n.endsWith(".sql")).sort()) {
  spawnSync("psql", ["-h", "postgres", "-U", "daftar", "-d", "daftar_test", "-v", "ON_ERROR_STOP=0", "-f", `/work/db/${f}`], {
    stdio: "ignore",
  });
}
if (!fs.existsSync("/work/node_modules/.bin/tsx")) {
  run("npm", ["ci", "--silent"], { cwd: "/work" });
}
run(
  "npx",
  [
    "tsx",
    "--test",
    "src/lib/company-match.test.ts",
    "src/lib/fiscal-year.test.ts",
    "src/server/books/inbox-review.test.ts",
  ],
  { cwd: "/work" },
);
