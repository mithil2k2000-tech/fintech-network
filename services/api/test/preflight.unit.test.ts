import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  formatReport,
  pendingMigrations,
  runPreflight,
} from "../src/ops/preflight.js";

// Phase 17. Preflight is the deploy's first step, so the case that
// matters most is the one where it says no — and that has to be
// provable without an actual bad deployment.

const MIGRATIONS = join(process.cwd(), "../../infra/migrations");

const GOOD_ENV = {
  NODE_ENV: "production",
  JWT_SECRET: "a-real-secret-of-more-than-thirty-two-characters",
  ALLOWED_ORIGINS: "https://app.example.com",
};

function fakeDb(rows: { name: string }[]) {
  return {
    async query(text: string) {
      if (text.includes("pgmigrations")) return { rows, rowCount: rows.length } as never;
      return { rows: [{ "?column?": 1 }], rowCount: 1 } as never;
    },
  };
}

describe("which migrations haven't run yet", () => {
  it("is the files on disk minus what the database has a record of", () => {
    expect(
      pendingMigrations(
        ["100_a.js", "200_b.js", "300_c.js"],
        ["100_a", "200_b"]
      )
    ).toEqual(["300_c"]);
  });

  it("returns them in the order they'd be applied", () => {
    expect(pendingMigrations(["300_c.js", "100_a.js", "200_b.js"], [])).toEqual([
      "100_a",
      "200_b",
      "300_c",
    ]);
  });

  it("ignores anything that isn't a migration", () => {
    expect(pendingMigrations(["100_a.js", "README.md", ".keep"], [])).toEqual(["100_a"]);
  });

  it("says nothing is pending when the database is up to date", () => {
    expect(pendingMigrations(["100_a.js"], ["100_a"])).toEqual([]);
  });
});

describe("preflight", () => {
  it("passes an environment that's configured and up to date", async () => {
    // Every migration in the repo, already applied.
    const applied = [
      "1789642393528_create-users-and-audit-events",
      "1789643166448_create-ledger",
    ].map((name) => ({ name }));
    const report = await runPreflight({
      env: GOOD_ENV,
      migrationsDir: MIGRATIONS,
      q: fakeDb(applied),
    });
    expect(report.checks.config.ok).toBe(true);
    expect(report.checks.database.ok).toBe(true);
    // The repo has more migrations than this fake database has run, so
    // the rest are pending — which is a note, not a failure.
    expect(report.checks.migrations.pending.length).toBeGreaterThan(0);
    expect(report.ok).toBe(true);
  });

  it("refuses an environment that isn't configured for production", async () => {
    const report = await runPreflight({
      env: { NODE_ENV: "production" },
      migrationsDir: MIGRATIONS,
      q: fakeDb([]),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.config.ok).toBe(false);
    expect(report.checks.config.problems.join(" ")).toMatch(/JWT_SECRET/);
  });

  it("stops at the database when it can't be reached, and says so", async () => {
    const report = await runPreflight({
      env: GOOD_ENV,
      migrationsDir: MIGRATIONS,
      q: {
        async query() {
          throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
        },
      },
    });
    expect(report.ok).toBe(false);
    expect(report.checks.database.error).toMatch(/ECONNREFUSED/);
    // A migration count taken without a database would be a made-up
    // number, so it isn't taken.
    expect(report.checks.migrations.error).toMatch(/unreachable/);
  });

  it("treats an empty database as everything pending, not as broken", async () => {
    const report = await runPreflight({
      env: GOOD_ENV,
      migrationsDir: MIGRATIONS,
      q: {
        async query(text: string) {
          if (text.includes("pgmigrations")) {
            throw new Error('relation "pgmigrations" does not exist');
          }
          return { rows: [], rowCount: 0 } as never;
        },
      },
    });
    // Deploying to a brand new database is a normal thing to do.
    expect(report.ok).toBe(true);
    expect(report.checks.migrations.applied).toBe(0);
    expect(report.checks.migrations.pending.length).toBeGreaterThan(5);
  });

  it("reads as a verdict, for someone skimming a deploy log", async () => {
    const good = formatReport({
      ok: true,
      checks: {
        config: { ok: true, problems: [] },
        database: { ok: true },
        migrations: { ok: true, pending: [], applied: 10 },
      },
    });
    expect(good).toMatch(/Safe to proceed/);

    const bad = formatReport({
      ok: false,
      checks: {
        config: { ok: false, problems: ["JWT_SECRET is not set"] },
        database: { ok: true },
        migrations: { ok: true, pending: [], applied: 10 },
      },
    });
    expect(bad).toMatch(/FAIL configuration/);
    expect(bad).toMatch(/JWT_SECRET is not set/);
    expect(bad).toMatch(/Do not deploy/);
  });
});
