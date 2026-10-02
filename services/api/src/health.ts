import type { Queryable } from "./db.js";

// Health module — used by Docker/orchestration and by smoke tests.
// Deliberately has no dependency on the domain modules below it.
//
// Phase 15 split this in two, because the two questions an orchestrator
// asks are different and answering them with one endpoint gets services
// killed for no reason:
//
//   * Liveness ("is this process alive?") must not touch the database.
//     If it did, a database blip would restart every API instance —
//     turning a recoverable outage into a thundering herd against a
//     database that is already struggling.
//   * Readiness ("should traffic come here?") must touch it, because an
//     instance that can't reach its database can't serve anything.

export interface HealthStatus {
  status: "ok";
  service: "api";
  timestamp: string;
}

export interface ReadinessStatus {
  status: "ready" | "not_ready";
  service: "api";
  checks: { database: { ok: boolean; latencyMs?: number; error?: string } };
  timestamp: string;
}

export function getHealthStatus(): HealthStatus {
  return {
    status: "ok",
    service: "api",
    timestamp: new Date().toISOString(),
  };
}

export async function getReadiness(q: Queryable): Promise<ReadinessStatus> {
  const startedAt = Date.now();
  try {
    await q.query("select 1");
    return {
      status: "ready",
      service: "api",
      checks: { database: { ok: true, latencyMs: Date.now() - startedAt } },
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    // The message is the driver's, not ours, and it goes no further than
    // an operator's terminal: this endpoint isn't public.
    return {
      status: "not_ready",
      service: "api",
      checks: { database: { ok: false, error: (err as Error).message } },
      timestamp: new Date().toISOString(),
    };
  }
}
