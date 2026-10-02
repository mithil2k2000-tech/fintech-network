# Migrations

Managed by `node-pg-migrate`, run from `services/api`:

```
pnpm --filter @fintech-network/api migrate up
```

Phase 1 ships with zero migrations — this proves the runner works against
an empty database. The first real migration (users/accounts tables) lands
in Phase 2. Never hand-edit a schema that mirrors this shape (spec §23).
