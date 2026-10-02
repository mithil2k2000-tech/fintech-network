import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Phase 16. The additive-only migration rule has been followed by hand
// since Phase 1; this is the check that makes it a rule rather than a
// habit. Driven as a subprocess, the way CI drives it, so what's tested
// is the gate itself — exit code and all — not a function that happens
// to sit behind it.

const CHECKER = join(process.cwd(), "../../scripts/check-migrations.mjs");

async function check(dir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("node", [CHECKER, "--dir", dir]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("the additive-only migration check", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "migration-check-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (name: string, source: string) => writeFile(join(dir, name), source);

  it("passes a migration that only adds", async () => {
    await write(
      "1000_add-a-column.js",
      `exports.up = (pgm) => { pgm.addColumn("payments", { note: { type: "text" } }); };
       exports.down = (pgm) => { pgm.dropColumn("payments", "note"); };`
    );
    const result = await check(dir);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/all additive/);
  });

  it("allows a rollback to undo things — that's what down() is for", async () => {
    // The previous test's file already proves this: its down() drops a
    // column and the check passed. Stated as its own expectation so the
    // intent survives someone rewriting the file above.
    const result = await check(dir);
    expect(result.code).toBe(0);
  });

  it("fails a migration that drops a column on the way up", async () => {
    await write(
      "1001_drop-a-column.js",
      `exports.up = (pgm) => { pgm.dropColumn("payments", "purpose"); };
       exports.down = (pgm) => {};`
    );
    const result = await check(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/1001_drop-a-column\.js: dropColumn/);
    // And it says what to do about it, rather than just refusing.
    expect(result.stderr).toMatch(/DESTRUCTIVE-MIGRATION-APPROVED/);
  });

  it("catches the same thing written as raw SQL", async () => {
    await rm(join(dir, "1001_drop-a-column.js"));
    await write(
      "1002_raw-drop.js",
      `exports.up = (pgm) => { pgm.sql("alter table payments drop column purpose"); };`
    );
    const result = await check(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/raw DROP/);
  });

  it("catches a type change, which breaks the running version just as hard", async () => {
    await rm(join(dir, "1002_raw-drop.js"));
    await write(
      "1003_retype.js",
      `exports.up = (pgm) => { pgm.alterColumn("payments", "purpose", { type: "varchar(10)" }); };`
    );
    const result = await check(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/alterColumn/);
  });

  it("lets a deliberate removal through when the file says it's deliberate", async () => {
    await write(
      "1003_retype.js",
      `// DESTRUCTIVE-MIGRATION-APPROVED: the column is unused since v2 and the
       // deploy that removes it goes out after the code that stopped reading it.
       exports.up = (pgm) => { pgm.dropColumn("payments", "legacy_note"); };`
    );
    const result = await check(dir);
    expect(result.code, result.stderr).toBe(0);
  });

  it("passes this repository's own migrations", async () => {
    const result = await check(join(process.cwd(), "../../infra/migrations"));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Checked \d+ migrations/);
  });
});
