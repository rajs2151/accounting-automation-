#!/usr/bin/env node
/**
 * Runs inside the Playwright Linux image. Assumes /work is the repo mount and
 * node_modules / .next are Linux volumes (not Windows host installs).
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.env.E2E_IN_CONTAINER !== "1" && !existsSync("/.dockerenv")) {
  console.error("e2e-docker-inner.mjs must run inside the Playwright container (E2E_IN_CONTAINER=1)");
  process.exit(2);
}

run("apt-get", ["update", "-qq"]);
run("apt-get", ["install", "-y", "-qq", "postgresql-client"], {
  env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
});

// Fresh Linux install into the shadowed volume — never reuse host win32 binaries.
// Retry npm ci once on flaky registry disconnects.
{
  let npmOk = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`+ npm ci (attempt ${attempt}/2)`);
    const result = spawnSync("npm", ["ci"], { stdio: "inherit" });
    if (result.status === 0) {
      npmOk = true;
      break;
    }
    console.error(`npm ci failed with status ${result.status ?? 1}`);
  }
  if (!npmOk) process.exit(1);
}

// Webpack production build (not turbopack). output: standalone → node server.js for e2e.
run("npx", ["next", "build"]);

const standalone = path.join(process.cwd(), ".next", "standalone");
mkdirSync(path.join(standalone, ".next"), { recursive: true });
cpSync(path.join(process.cwd(), ".next", "static"), path.join(standalone, ".next", "static"), {
  recursive: true,
});
if (existsSync(path.join(process.cwd(), "public"))) {
  cpSync(path.join(process.cwd(), "public"), path.join(standalone, "public"), { recursive: true });
}
// Ensure pdfjs is available beside standalone server for sync extract
const pdfjsSrc = path.join(process.cwd(), "node_modules", "pdfjs-dist");
const pdfjsDest = path.join(standalone, "node_modules", "pdfjs-dist");
if (existsSync(pdfjsSrc)) {
  mkdirSync(path.join(standalone, "node_modules"), { recursive: true });
  cpSync(pdfjsSrc, pdfjsDest, { recursive: true });
}

process.env.PORT = process.env.PORT || "43127";
process.env.HOSTNAME = process.env.HOSTNAME || "127.0.0.1";
process.env.E2E_IN_CONTAINER = "1";
process.env.E2E_WEB_COMMAND =
  process.env.E2E_WEB_COMMAND || `node .next/standalone/server.js`;

const pwArgs = ["playwright", "test"];
if (process.env.E2E_UPDATE_SNAPSHOTS === "1") pwArgs.push("--update-snapshots");

// Phase 1 ship gate (default): only books-phase1 specs. Legacy suite via E2E_PHASE1_GATE=0.
const phase1Gate = process.env.E2E_PHASE1_GATE !== "0";
if (phase1Gate) {
  pwArgs.push("e2e/books-phase1.spec.ts");
  console.log("+ E2E_PHASE1_GATE: running e2e/books-phase1.spec.ts only");
}
run("npx", pwArgs);
