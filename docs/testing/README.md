# Tests, and the pipeline that runs them

Three layers, and each one exists because the layer below it can't
answer the question.

| Layer | What it proves | Needs |
| --- | --- | --- |
| Unit | The arithmetic and the rules: money splitting, cashback, the risk rules, the assistant's templates, the metrics registry, the migration gate. | Nothing |
| Integration | That the API and a real Postgres agree — constraints, transactions, triggers, authorisation from every side. | Postgres, migrations applied |
| End-to-end | That a person can actually do it, in a browser, across all three apps. | Postgres, all four servers |

```bash
pnpm verify   # everything CI runs, in the same order
```

That one command is the point of this page: "it passed locally" and "it
passed in CI" should mean the same thing, and they only do if they run
the same steps.

Individually:

```bash
pnpm check:migrations                  # additive-only gate
pnpm typecheck
pnpm test                              # unit, no database
pnpm build
pnpm test:integration                  # needs DATABASE_URL + JWT_SECRET
pnpm e2e                               # starts the API and all three apps itself
```

## What CI does

`.github/workflows/ci.yml`, on every push to `main` and every pull
request. Four parallel jobs plus an image build, split by what they
need rather than what they are — so a type error comes back in about a
minute instead of queueing behind a browser suite.

- **checks** — the additive-migration gate, typecheck, unit tests,
  build. No database.
- **integration** — a Postgres service container, migrations applied,
  the full integration suite.
- **e2e** — the same, plus Chromium; on failure it keeps the Playwright
  traces for a week. Only on failure, and only for a week: a trace is a
  recording of the app with test data in it.
- **migrations** — an *empty* database, every migration in order, then
  the newest one rolled back and forward again. Two failures this
  catches that nothing else does: a migration that only works against a
  database which already has last month's data in it, and a `down` that
  was never tried — which is discovered, otherwise, during an incident,
  when rolling back is the only thing anyone wants.
- **image** — builds the API image. Not pushed: there is no registry for
  a prototype that moves no real money, and wiring one up before there
  is somewhere to deploy would be pipeline theatre. What it proves is
  that the image still builds, which is the part that quietly rots.

A second push to a branch cancels the first run: the older answer is
about code nobody has any more.

## The additive-migration gate

`scripts/check-migrations.mjs` fails the build if a migration's `up()`
drops a table or column, renames one, or changes a column's type —
including in raw SQL. `down()` is free to do any of it; that's what a
rollback is.

The rule isn't fussiness. A migration that removes something breaks the
running version of the API the moment it lands, because the old code is
still serving requests while the new schema is in place. Adding is safe;
removing needs two deploys and a deliberate decision.

When the removal really is deliberate, the file says so: a comment
containing `DESTRUCTIVE-MIGRATION-APPROVED`. One line, greppable,
reviewable — which is the point, rather than a flag nobody sees.

## What there isn't

**No linter.** The compiler and the tests are the gates. Adding ESLint
to seven workspaces mid-project buys a long tail of fixes and very
little that `tsc --strict` plus a real integration suite doesn't already
catch — but it's a reasonable thing to add, and nothing here is in its
way.

**No coverage threshold.** A percentage is easy to hit and says nothing
about whether the risky paths are covered. What's covered instead is
chosen deliberately: every money calculation, every state transition,
every authorisation boundary, and the invariants swept in the database
after each phase.

**No flake retries.** The suite either passes or something is wrong.
Retries are how a real race condition turns into a slow test nobody
trusts.
