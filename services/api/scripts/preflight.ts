#!/usr/bin/env tsx
// The deploy's first step: ask whether this environment is fit to
// deploy to, before anything is taken down.
//
//   pnpm --filter @fintech-network/api preflight
//
// Exit 0: go ahead (pending migrations are reported, not refused).
// Exit 1: something is wrong — do not deploy.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPool, closePool } from "../src/db.js";
import { formatReport, runPreflight } from "../src/ops/preflight.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const pool = getPool();
  try {
    const report = await runPreflight({
      q: pool,
      migrationsDir: process.env.MIGRATIONS_DIR ?? join(here, "../../../infra/migrations"),
    });
    console.log(formatReport(report));
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await closePool();
  }
}

await main();
