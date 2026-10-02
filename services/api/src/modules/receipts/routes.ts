import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { authenticate } from "../identity/middleware.js";
import { getPaymentStatusById } from "../payments/index.js";
import { listMerchantIdsForUser } from "../merchants/index.js";
import { idParamsSchema } from "../../shared/validation.js";
import { findReceiptForViewer, toReceiptView, type Receipt } from "./index.js";

function receiptNotFound(reply: FastifyReply) {
  // Same answer for "doesn't exist" and "not yours" (IDOR protection).
  return reply.status(404).send({
    code: "RECEIPT_NOT_FOUND",
    message: "Receipt not found",
    requestId: reply.request.id,
  });
}

export async function receiptsRoutes(app: FastifyInstance, opts: { pool: Pool }) {
  const { pool } = opts;

  async function respond(reply: FastifyReply, userId: string, receipt: Receipt | null) {
    if (!receipt) return receiptNotFound(reply);
    // The receipt lookup already decided this viewer is one of the two
    // sides, so all that's left is the live status (a later refund
    // shows here) — receipts themselves never change.
    const status = await getPaymentStatusById(pool, receipt.paymentId);
    if (!status) return receiptNotFound(reply);
    return reply.send({ receipt: toReceiptView(receipt, userId, status) });
  }

  /** The two sides of a receipt: the person, and any shop they work for. */
  async function viewerFor(userId: string) {
    return { userId, merchantIds: await listMerchantIdsForUser(pool, userId) };
  }

  app.get(
    "/api/v1/receipts/:id",
    { onRequest: authenticate, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.sub;
      const receipt = await findReceiptForViewer(pool, await viewerFor(userId), {
        receiptId: id,
      });
      return respond(reply, userId, receipt);
    }
  );

  app.get(
    "/api/v1/payments/:id/receipt",
    { onRequest: authenticate, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.sub;
      const receipt = await findReceiptForViewer(pool, await viewerFor(userId), {
        paymentId: id,
      });
      return respond(reply, userId, receipt);
    }
  );
}
