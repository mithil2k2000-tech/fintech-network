import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { authenticate } from "../identity/middleware.js";
import { idParamsSchema } from "../../shared/validation.js";
import { listPaymentRequestsForMerchant, PaymentRequestError } from "../paymentRequests/index.js";
import {
  MerchantError,
  addMerchantMember,
  createMerchant,
  getMerchantBalance,
  getMerchantForMember,
  listMerchantMembers,
  listMerchantsForUser,
} from "./index.js";

const createBody = {
  type: "object",
  required: ["legalName", "tradingName", "contactEmail"],
  additionalProperties: false,
  properties: {
    legalName: { type: "string", minLength: 2, maxLength: 140 },
    tradingName: { type: "string", minLength: 2, maxLength: 80 },
    contactEmail: { type: "string", minLength: 3, maxLength: 255 },
  },
} as const;

const addMemberBody = {
  type: "object",
  required: ["email", "role"],
  additionalProperties: false,
  properties: {
    email: { type: "string", minLength: 3, maxLength: 255 },
    role: { type: "string", enum: ["owner", "staff"] },
  },
} as const;

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof MerchantError || err instanceof PaymentRequestError) {
    return reply.status(err.httpStatus).send({
      code: err.code,
      message: err.message,
      requestId: reply.request.id,
    });
  }
  throw err; // falls through to the global error handler
}

export interface MerchantsDeps {
  pool: Pool;
  writeRateLimitPerMinute?: number;
}

export async function merchantsRoutes(app: FastifyInstance, deps: MerchantsDeps) {
  const { pool } = deps;
  const max = deps.writeRateLimitPerMinute ?? 30;
  const writeLimit = { rateLimit: { max, timeWindow: "1 minute" } };

  app.post(
    "/api/v1/merchants",
    { onRequest: authenticate, schema: { body: createBody }, config: writeLimit },
    async (request, reply) => {
      const body = request.body as {
        legalName: string;
        tradingName: string;
        contactEmail: string;
      };
      try {
        const merchant = await createMerchant(pool, {
          userId: request.user!.sub,
          legalName: body.legalName,
          tradingName: body.tradingName,
          contactEmail: body.contactEmail,
        });
        return reply.status(201).send({ merchant });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.get("/api/v1/merchants", { onRequest: authenticate }, async (request, reply) => {
    const merchants = await listMerchantsForUser(pool, request.user!.sub);
    return reply.send({ merchants });
  });

  app.get(
    "/api/v1/merchants/:id",
    { onRequest: authenticate, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const merchant = await getMerchantForMember(pool, request.user!.sub, id);
        return reply.send({ merchant });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.get(
    "/api/v1/merchants/:id/account",
    { onRequest: authenticate, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const account = await getMerchantBalance(pool, request.user!.sub, id);
        return reply.send({ account });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.get(
    "/api/v1/merchants/:id/payment-requests",
    { onRequest: authenticate, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const paymentRequests = await listPaymentRequestsForMerchant(
          pool,
          request.user!.sub,
          id
        );
        return reply.send({ paymentRequests });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.get(
    "/api/v1/merchants/:id/members",
    { onRequest: authenticate, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const members = await listMerchantMembers(pool, request.user!.sub, id);
        return reply.send({ members });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.post(
    "/api/v1/merchants/:id/members",
    {
      onRequest: authenticate,
      schema: { params: idParamsSchema, body: addMemberBody },
      config: writeLimit,
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { email: string; role: "owner" | "staff" };
      try {
        const member = await addMerchantMember(pool, request.user!.sub, id, body);
        return reply.status(201).send({ member });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );
}
