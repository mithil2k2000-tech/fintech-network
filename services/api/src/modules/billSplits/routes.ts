import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { authenticate } from "../identity/middleware.js";
import { PaymentRequestError, MAX_EXPIRY_MINUTES } from "../paymentRequests/index.js";
import { MAX_PAYMENT_MINOR_UNITS } from "../payments/routes.js";
import { idParamsSchema } from "../../shared/validation.js";
import {
  BillSplitError,
  MAX_SPLIT_PARTS,
  cancelBillSplit,
  createBillSplit,
  getBillSplitForUser,
  listBillSplitsForUser,
} from "./index.js";

export interface BillSplitsDeps {
  pool: Pool;
  writeRateLimitPerMinute?: number;
}

const createBody = {
  type: "object",
  required: ["totalMinorUnits", "participantEmails"],
  additionalProperties: false,
  properties: {
    // "integer" rejects 12.5 — money never travels as a float.
    totalMinorUnits: { type: "integer", minimum: 1, maximum: MAX_PAYMENT_MINOR_UNITS },
    purpose: { type: "string", maxLength: 140 },
    participantEmails: {
      type: "array",
      minItems: 1,
      maxItems: MAX_SPLIT_PARTS - 1,
      items: { type: "string", minLength: 3, maxLength: 255 },
    },
    shareMinorUnits: {
      type: "array",
      minItems: 2,
      maxItems: MAX_SPLIT_PARTS,
      items: { type: "integer", minimum: 1, maximum: MAX_PAYMENT_MINOR_UNITS },
    },
    includeOrganiser: { type: "boolean" },
    expiresInMinutes: { type: "integer", minimum: 1, maximum: MAX_EXPIRY_MINUTES },
  },
} as const;

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof BillSplitError || err instanceof PaymentRequestError) {
    return reply.status(err.httpStatus).send({
      code: err.code,
      message: err.message,
      requestId: reply.request.id,
    });
  }
  throw err; // falls through to the global error handler
}

export async function billSplitsRoutes(app: FastifyInstance, deps: BillSplitsDeps) {
  const { pool } = deps;
  const max = deps.writeRateLimitPerMinute ?? 30;
  const writeLimit = { rateLimit: { max, timeWindow: "1 minute" } };

  app.post(
    "/api/v1/bill-splits",
    { onRequest: authenticate, schema: { body: createBody }, config: writeLimit },
    async (request, reply) => {
      const body = request.body as {
        totalMinorUnits: number;
        purpose?: string;
        participantEmails: string[];
        shareMinorUnits?: number[];
        includeOrganiser?: boolean;
        expiresInMinutes?: number;
      };
      try {
        const billSplit = await createBillSplit(pool, {
          userId: request.user!.sub,
          totalMinorUnits: body.totalMinorUnits,
          purpose: body.purpose?.trim() || null,
          participantEmails: body.participantEmails,
          shareMinorUnits: body.shareMinorUnits,
          includeOrganiser: body.includeOrganiser,
          expiresInMinutes: body.expiresInMinutes,
        });
        return reply.status(201).send({ billSplit });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.get("/api/v1/bill-splits", { onRequest: authenticate }, async (request, reply) => {
    const billSplits = await listBillSplitsForUser(pool, request.user!.sub);
    return reply.send({ billSplits });
  });

  app.get(
    "/api/v1/bill-splits/:id",
    { onRequest: authenticate, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const billSplit = await getBillSplitForUser(pool, request.user!.sub, id);
        return reply.send({ billSplit });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.post(
    "/api/v1/bill-splits/:id/cancel",
    { onRequest: authenticate, schema: { params: idParamsSchema }, config: writeLimit },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const billSplit = await cancelBillSplit(pool, request.user!.sub, id);
        return reply.send({ billSplit });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );
}
