import type { FastifyInstance, FastifyReply } from "fastify";
import { authenticate } from "../identity/middleware.js";
import { PaymentError, type PaymentsDeps } from "../payments/index.js";
import { MerchantError } from "../merchants/index.js";
import { MAX_PAYMENT_MINOR_UNITS } from "../payments/routes.js";
import { idParamsSchema } from "../../shared/validation.js";
import {
  MAX_EXPIRY_MINUTES,
  PaymentRequestError,
  cancelPaymentRequest,
  countWaitingPaymentRequests,
  createPaymentRequest,
  declinePaymentRequest,
  getOwnPaymentRequest,
  listIncomingPaymentRequests,
  listOwnPaymentRequests,
  payPaymentRequest,
  resolvePaymentRequest,
} from "./index.js";

const createBody = {
  type: "object",
  required: ["amountMinorUnits"],
  additionalProperties: false,
  properties: {
    amountMinorUnits: { type: "integer", minimum: 1, maximum: MAX_PAYMENT_MINOR_UNITS },
    purpose: { type: "string", maxLength: 140 },
    expiresInMinutes: { type: "integer", minimum: 1, maximum: MAX_EXPIRY_MINUTES },
    // Present: ask this person. Absent: a QR anyone can pay.
    toEmail: { type: "string", minLength: 3, maxLength: 255 },
    // Present: take it for this shop instead of for yourself.
    asMerchantId: { type: "string", format: "uuid" },
  },
} as const;

const keyParams = {
  type: "object",
  required: ["key"],
  properties: { key: { type: "string", minLength: 8, maxLength: 64 } },
} as const;

function sendError(reply: FastifyReply, err: unknown) {
  if (
    err instanceof PaymentRequestError ||
    err instanceof PaymentError ||
    err instanceof MerchantError
  ) {
    return reply.status(err.httpStatus).send({
      code: err.code,
      message: err.message,
      requestId: reply.request.id,
    });
  }
  throw err;
}

export async function paymentRequestsRoutes(app: FastifyInstance, deps: PaymentsDeps) {
  const { pool } = deps;
  const max = deps.writeRateLimitPerMinute ?? 30;
  const writeLimit = { rateLimit: { max, timeWindow: "1 minute" } };
  // Codes are short, so looking one up counts against the same budget.
  const lookupLimit = writeLimit;

  app.post(
    "/api/v1/payment-requests",
    { onRequest: authenticate, schema: { body: createBody }, config: writeLimit },
    async (request, reply) => {
      const body = request.body as {
        amountMinorUnits: number;
        purpose?: string;
        expiresInMinutes?: number;
        toEmail?: string;
        asMerchantId?: string;
      };
      try {
        const paymentRequest = await createPaymentRequest(pool, {
          userId: request.user!.sub,
          amountMinorUnits: body.amountMinorUnits,
          purpose: body.purpose?.trim() || null,
          expiresInMinutes: body.expiresInMinutes,
          toEmail: body.toEmail,
          asMerchantId: body.asMerchantId,
        });
        return reply.status(201).send({ paymentRequest });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.get(
    "/api/v1/payment-requests",
    { onRequest: authenticate },
    async (request, reply) => {
      const paymentRequests = await listOwnPaymentRequests(pool, request.user!.sub);
      return reply.send({ paymentRequests });
    }
  );

  // Registered before "/:id" so "incoming" is never read as an id.
  app.get(
    "/api/v1/payment-requests/incoming",
    { onRequest: authenticate },
    async (request, reply) => {
      const [paymentRequests, waitingCount] = await Promise.all([
        listIncomingPaymentRequests(pool, request.user!.sub),
        countWaitingPaymentRequests(pool, request.user!.sub),
      ]);
      return reply.send({ paymentRequests, waitingCount });
    }
  );

  // Registered before "/:id" routes so "resolve" is never read as an id.
  app.get(
    "/api/v1/payment-requests/resolve/:key",
    { onRequest: authenticate, schema: { params: keyParams }, config: lookupLimit },
    async (request, reply) => {
      const { key } = request.params as { key: string };
      try {
        const paymentRequest = await resolvePaymentRequest(pool, request.user!.sub, key);
        return reply.send({ paymentRequest });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.get(
    "/api/v1/payment-requests/:id",
    { onRequest: authenticate, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const paymentRequest = await getOwnPaymentRequest(pool, request.user!.sub, id);
        return reply.send({ paymentRequest });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.post(
    "/api/v1/payment-requests/:id/cancel",
    { onRequest: authenticate, schema: { params: idParamsSchema }, config: writeLimit },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const paymentRequest = await cancelPaymentRequest(pool, request.user!.sub, id);
        return reply.send({ paymentRequest });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.post(
    "/api/v1/payment-requests/:id/decline",
    { onRequest: authenticate, schema: { params: idParamsSchema }, config: writeLimit },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const paymentRequest = await declinePaymentRequest(pool, request.user!.sub, id);
        return reply.send({ paymentRequest });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  app.post(
    "/api/v1/payment-requests/:id/pay",
    { onRequest: authenticate, schema: { params: idParamsSchema }, config: writeLimit },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const payment = await payPaymentRequest(deps, {
          payerUserId: request.user!.sub,
          requestId: id,
        });
        return reply.status(201).send({ payment });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );
}
