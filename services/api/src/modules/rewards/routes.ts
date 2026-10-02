import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { authenticate } from "../identity/middleware.js";
import { TREE_STAGES, getCashbackSummary, getRewardsTree } from "./index.js";

export async function rewardsRoutes(app: FastifyInstance, opts: { pool: Pool }) {
  const { pool } = opts;

  // What you've earned, and what's on offer — so the app shows the rate
  // the server is actually applying rather than a number in a screen.
  app.get("/api/v1/rewards/cashback", { onRequest: authenticate }, async (request, reply) => {
    const cashback = await getCashbackSummary(pool, request.user!.sub);
    return reply.send({ cashback });
  });

  // The tree, plus the whole ladder of stages, so the app can show what
  // comes next without repeating the thresholds in a screen.
  app.get("/api/v1/rewards/tree", { onRequest: authenticate }, async (request, reply) => {
    const tree = await getRewardsTree(pool, request.user!.sub);
    return reply.send({ tree, stages: TREE_STAGES });
  });
}
