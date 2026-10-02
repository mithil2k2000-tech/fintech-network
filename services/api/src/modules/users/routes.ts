import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { authenticate } from "../identity/middleware.js";
import { findUserById } from "./index.js";

export async function usersRoutes(app: FastifyInstance, opts: { pool: Pool }) {
  const { pool } = opts;

  app.get(
    "/api/v1/users/me",
    { onRequest: authenticate },
    async (request, reply) => {
      const user = await findUserById(pool, request.user!.sub);
      if (!user) {
        return reply.status(404).send({
          code: "USER_NOT_FOUND",
          message: "User no longer exists",
          requestId: reply.request.id,
        });
      }
      return reply.send({ user });
    }
  );
}
