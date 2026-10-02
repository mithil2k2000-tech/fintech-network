import type { FastifyInstance, FastifyReply } from "fastify";
import { authenticate } from "../identity/middleware.js";
import {
  PaymentError,
  cancelPayment,
  confirmPayment,
  createPayment,
  getPaymentForUser,
  listPaymentsForUser,
  type PaymentsDeps,
} from "./index.js";
import { idParamsSchema } from "../../shared/validation.js";

// £10,000.00 per payment. A prototype guard-rail, not a product rule —
// real limits belong to the risk engine and provider later.
export const MAX_PAYMENT_MINOR_UNITS = 1_000_000;

const idParams = idParamsSchema;

const createBody = {
  type: "object",
  required: ["recipientEmail", "amountMinorUnits"],
  additionalProperties: false,
  properties: {
    recipientEmail: { type: "string", minLength: 3, maxLength: 255 },
    // "integer" rejects 12.5 — money never travels as a float.
    amountMinorUnits: {
      type: "integer",
      minimum: 1,
      maximum: MAX_PAYMENT_MINOR_UNITS,
    },
    purpose: { type: "string", maxLength: 140 },
  },
} as const;

const confirmBody = {
  type: "object",
  additionalProperties: false,
  properties: { acknowledgeRisk: { type: "boolean" } },
} as const;

function sendPaymentError(reply: FastifyReply, err: unknown) {
  if (err instanceof PaymentError) {
    return reply.status(err.httpStatus).send({
      code: err.code,
      message: err.message,
      details: err.details,
      requestId: reply.request.id,
    });
  }
  throw err; // falls through to the global error handler
}

export async function paymentsRoutes(app: FastifyInstance, deps: PaymentsDeps) {
  const max = deps.writeRateLimitPerMinute ?? 30;
  const writeLimit = { rateLimit: { max, timeWindow: "1 minute" } };

  app.post(
    "/api/v1/payments",
    { onRequest: authenticate, schema: { body: createBody }, config: writeLimit },
    async (request, reply) => {
      const body = request.body as {
        recipientEmail: string;
        amountMinorUnits: number;
        purpose?: string;
      };
      try {
        const payment = await createPayment(deps, {
          payerUserId: request.user!.sub,
          recipientEmail: body.recipientEmail,
          amountMinorUnits: body.amountMinorUnits,
          purpose: body.purpose ?? null,
        });
        return reply.status(201).send({ payment });
      } catch (err) {
        return sendPaymentError(reply, err);
      }
    }
  );

  app.post(
    "/api/v1/payments/:id/confirm",
    {
      onRequest: authenticate,
      schema: { params: idParams, body: confirmBody },
      config: writeLimit,
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { acknowledgeRisk?: boolean };
      try {
        const payment = await confirmPayment(deps, {
          payerUserId: request.user!.sub,
          paymentId: id,
          acknowledgeRisk: body.acknowledgeRisk,
        });
        return reply.send({ payment });
      } catch (err) {
        return sendPaymentError(reply, err);
      }
    }
  );

  app.post(
    "/api/v1/payments/:id/cancel",
    { onRequest: authenticate, schema: { params: idParams }, config: writeLimit },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const payment = await cancelPayment(deps, {
          payerUserId: request.user!.sub,
          paymentId: id,
        });
        return reply.send({ payment });
      } catch (err) {
        return sendPaymentError(reply, err);
      }
    }
  );

  app.get(
    "/api/v1/payments/:id",
    { onRequest: authenticate, schema: { params: idParams } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const payment = await getPaymentForUser(deps.pool, request.user!.sub, id);
        return reply.send({ payment });
      } catch (err) {
        return sendPaymentError(reply, err);
      }
    }
  );

  app.get(
    "/api/v1/payments",
    { onRequest: authenticate },
    async (request, reply) => {
      const payments = await listPaymentsForUser(deps.pool, request.user!.sub);
      return reply.send({ payments });
    }
  );
}
