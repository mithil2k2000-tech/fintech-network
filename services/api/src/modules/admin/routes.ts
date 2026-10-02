import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { authenticate, requireRole } from "../identity/middleware.js";
import { clampWindowHours, getOperationsOverview, MAX_WINDOW_HOURS } from "./index.js";

// The admin surface. Since Phase 2 the only thing behind `requireRole`
// has been a demo ping; this is the first thing that actually needs it.
//
// Read-only by design. An operations view that can also change things
// is a much bigger blast radius than one that can only look, and
// nothing here needs to change anything.

export async function adminRoutes(app: FastifyInstance, opts: { pool: Pool }) {
  const { pool } = opts;
  const adminOnly = { onRequest: [authenticate, requireRole(pool, "admin")] };

  // Kept from Phase 2: the smallest possible proof that RBAC works end
  // to end, and the thing Success Scenario 8 drives.
  app.get("/api/v1/admin/ping", adminOnly, async () => ({ pong: true }));

  app.get(
    "/api/v1/admin/overview",
    {
      ...adminOnly,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            // Query strings aren't type-coerced (see buildApp), so this
            // arrives as digits and is parsed here.
            windowHours: { type: "string", pattern: "^[0-9]{1,5}$" },
          },
        },
      },
    },
    async (request, reply) => {
      const { windowHours } = request.query as { windowHours?: string };
      const hours = clampWindowHours(
        windowHours === undefined ? undefined : Number.parseInt(windowHours, 10)
      );
      const overview = await getOperationsOverview(pool, hours);
      return reply.send({ overview, maxWindowHours: MAX_WINDOW_HOURS });
    }
  );
}
