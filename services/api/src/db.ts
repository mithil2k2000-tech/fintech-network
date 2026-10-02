import pg from "pg";

// Single shared connection pool for the whole API process.
// Modules must go through their own repository functions (below/in each
// module folder) — never reach into another module's queries directly
// (spec §17 Backend Architecture: module boundary rule).
const { Pool } = pg;

let pool: pg.Pool | undefined;

/**
 * Anything that can run a query: the shared Pool, or a PoolClient that's
 * inside a BEGIN/COMMIT block. Module functions accept this instead of a
 * concrete Pool so the same function works standalone or as one step of
 * a larger atomic operation — callers decide the transaction boundary.
 */
export interface Queryable {
  query<R extends pg.QueryResultRow = any>(
    text: string,
    values?: unknown[]
  ): Promise<pg.QueryResult<R>>;
}

export function getPool(): pg.Pool {
  if (!pool) {
    // No eager check here on purpose: constructing a Pool doesn't open a
    // connection, so routes that never touch the DB (health check) still
    // work with no DATABASE_URL set. A route that *does* query will fail
    // naturally, with a clear pg connection error, if it's missing.
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
