// Preflight: what a deploy should ask before it starts (Phase 17).
//
// Three questions, in the order that makes a failure cheap:
//
//   1. Is this environment configured to run in production at all?
//      (loadConfig, the same check the API itself refuses to start
//      without — asked here so the answer arrives before the old
//      version is taken down, not after.)
//   2. Can the database be reached with these credentials?
//   3. Which migrations haven't been applied to it yet?
//
// The third one is the reason this exists as a separate step rather
// than something the API does at boot. If every replica migrated on
// start-up, a deploy of four replicas would be four processes racing to
// alter the same schema. Migrations are a step of the deploy; the
// application only ever runs against a schema that is already there.
import { readdir } from "node:fs/promises";
import type { Queryable } from "../db.js";
import { ConfigError, loadConfig } from "../config.js";

export interface PreflightReport {
  ok: boolean;
  checks: {
    config: { ok: boolean; problems: string[] };
    database: { ok: boolean; error?: string };
    migrations: { ok: boolean; pending: string[]; applied: number; error?: string };
  };
}

/**
 * Migration files on disk that the database has no record of running.
 * Compared by name, which is what node-pg-migrate records, and sorted,
 * because the order they'd be applied in is the interesting part.
 */
export function pendingMigrations(files: string[], applied: string[]): string[] {
  const done = new Set(applied);
  return files
    .filter((file) => file.endsWith(".js"))
    .map((file) => file.replace(/\.js$/, ""))
    .filter((name) => !done.has(name))
    .sort();
}

async function migrationFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".js"));
}

export interface PreflightOptions {
  env?: NodeJS.ProcessEnv;
  migrationsDir: string;
  q: Queryable;
}

export async function runPreflight(options: PreflightOptions): Promise<PreflightReport> {
  const report: PreflightReport = {
    ok: true,
    checks: {
      config: { ok: true, problems: [] },
      database: { ok: true },
      migrations: { ok: true, pending: [], applied: 0 },
    },
  };

  try {
    loadConfig(options.env ?? process.env);
  } catch (err) {
    report.ok = false;
    report.checks.config = {
      ok: false,
      problems: err instanceof ConfigError ? [err.message] : [String(err)],
    };
  }

  try {
    await options.q.query("select 1");
  } catch (err) {
    report.ok = false;
    report.checks.database = { ok: false, error: (err as Error).message };
    // Without a database the migration check can't mean anything.
    report.checks.migrations = {
      ok: false,
      pending: [],
      applied: 0,
      error: "not checked: the database is unreachable",
    };
    return report;
  }

  try {
    const files = await migrationFiles(options.migrationsDir);
    const result = await options.q.query<{ name: string }>(
      `select name from pgmigrations order by run_on`
    );
    const applied = result.rows.map((row) => row.name);
    const pending = pendingMigrations(files, applied);
    report.checks.migrations = { ok: pending.length === 0, pending, applied: applied.length };
    // Pending migrations are not a failure — they're the next step of
    // the deploy. They're reported so the step isn't skipped by
    // accident, and so a surprise ("seven pending?") is seen before
    // anything is taken down.
  } catch (err) {
    const message = (err as Error).message;
    // A database with no pgmigrations table at all is an empty one,
    // which is a normal thing to deploy to — it just means everything
    // is pending.
    if (/pgmigrations/.test(message)) {
      const files = await migrationFiles(options.migrationsDir);
      report.checks.migrations = {
        ok: false,
        pending: pendingMigrations(files, []),
        applied: 0,
      };
    } else {
      report.ok = false;
      report.checks.migrations = { ok: false, pending: [], applied: 0, error: message };
    }
  }

  return report;
}

/** Human-readable, for a deploy log that someone will read in a hurry. */
export function formatReport(report: PreflightReport): string {
  const lines: string[] = [];
  const mark = (ok: boolean) => (ok ? "ok  " : "FAIL");

  lines.push(`${mark(report.checks.config.ok)} configuration`);
  for (const problem of report.checks.config.problems) lines.push(`       ${problem}`);

  lines.push(`${mark(report.checks.database.ok)} database reachable`);
  if (report.checks.database.error) lines.push(`       ${report.checks.database.error}`);

  const migrations = report.checks.migrations;
  const pending = migrations.pending.length;
  lines.push(
    `${pending === 0 && !migrations.error ? "ok  " : "note"} migrations: ${migrations.applied} applied, ${pending} pending`
  );
  for (const name of migrations.pending) lines.push(`       pending: ${name}`);
  if (migrations.error) lines.push(`       ${migrations.error}`);

  lines.push(
    report.ok
      ? "\nSafe to proceed. Apply any pending migrations, then deploy."
      : "\nDo not deploy. Fix the failures above first."
  );
  return lines.join("\n");
}
