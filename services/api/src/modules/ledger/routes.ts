import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { authenticate } from "../identity/middleware.js";
import { getOrCreateAccountForOwner, getBalanceMinorUnits } from "./index.js";

export async function ledgerRoutes(app: FastifyInstance, opts: { pool: Pool }) {
  const { pool } = opts;

  app.get(
    "/api/v1/accounts/me",
    { onRequest: authenticate },
    async (request, reply) => {
      const account = await getOrCreateAccountForOwner(
        pool,
        "user",
        request.user!.sub
      );
      const balanceMinorUnits = await getBalanceMinorUnits(pool, account.id);
      return reply.send({
        account: {
          id: account.id,
          currency: account.currency,
          balanceMinorUnits,
        },
      });
    }
  );
}
