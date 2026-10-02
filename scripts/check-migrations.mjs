#!/usr/bin/env node
// Migrations are additive (Phase 16, enforcing the rule this codebase
// has followed since Phase 1).
//
// The rule exists because a migration that drops or renames a column is
// a migration that breaks the running version of the API the moment it
// lands — the old code is still serving requests while the new schema
// is in place. Adding is safe; taking away needs two deploys and a
// deliberate decision, which is exactly the kind of decision that
// should not be made by accident at half past five on a Friday.
//
// So: a migration that removes something fails this check unless it
// says, in the file, that it means to.
//
//   Escape hatch: a comment containing DESTRUCTIVE-MIGRATION-APPROVED
//   somewhere in the file. It costs one line and makes the intent
//   greppable and reviewable, which is the whole point.
//
// Run: node scripts/check-migrations.mjs [--dir infra/migrations]

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const APPROVAL = "DESTRUCTIVE-MIGRATION-APPROVED";

/**
 * Things that take something away from a schema. `down` is allowed to
 * use them — that's what a rollback is — so only the `up` half of each
 * file is examined.
 */
const DESTRUCTIVE = [
  { pattern: /\bpgm\.dropTable\s*\(/, what: "dropTable" },
  { pattern: /\bpgm\.dropColumns?\s*\(/, what: "dropColumn" },
  { pattern: /\bpgm\.renameColumn\s*\(/, what: "renameColumn" },
  { pattern: /\bpgm\.renameTable\s*\(/, what: "renameTable" },
  { pattern: /\bpgm\.alterColumn\s*\([^)]*type\s*:/, what: "alterColumn (type change)" },
  { pattern: /\bdrop\s+(table|column)\b/i, what: "raw DROP" },
  { pattern: /\balter\s+table\b[^;]*\balter\s+column\b[^;]*\btype\b/i, what: "raw type change" },
];

/**
 * Only the `up` half. Splitting on the exports is crude and that's
 * fine: it errs towards checking too much, never too little, and a
 * false positive costs one comment.
 */
function upSection(source) {
  const downAt = source.search(/exports\.down\s*=/);
  return downAt === -1 ? source : source.slice(0, downAt);
}

export function findProblems(fileName, source) {
  if (source.includes(APPROVAL)) return [];
  const up = upSection(source);
  return DESTRUCTIVE.filter(({ pattern }) => pattern.test(up)).map(
    ({ what }) => `${fileName}: ${what} in up() — migrations are additive`
  );
}

async function main() {
  const dirFlag = process.argv.indexOf("--dir");
  const dir = dirFlag === -1 ? "infra/migrations" : process.argv[dirFlag + 1];

  let files;
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".js")).sort();
  } catch (err) {
    console.error(`Can't read ${dir}: ${err.message}`);
    process.exit(2);
  }

  const problems = [];
  for (const file of files) {
    const source = await readFile(join(dir, file), "utf8");
    problems.push(...findProblems(file, source));
  }

  if (problems.length > 0) {
    console.error("Additive-only migration check failed:\n");
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      `\nIf the change really is meant to remove something, say so: put a comment` +
        `\ncontaining ${APPROVAL} in the migration, and make sure the deploy that` +
        `\nuses it is sequenced so no running code needs what it takes away.\n`
    );
    process.exit(1);
  }

  console.log(`Checked ${files.length} migrations: all additive.`);
}

// Only run when invoked directly, so the check above can be unit-tested.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
