import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { authenticate } from "../identity/middleware.js";
import {
  AssistantQuestionError,
  MAX_QUESTION_LENGTH,
  askAssistant,
  assistantCapabilities,
  type AssistantModel,
} from "./index.js";

// The assistant's whole surface: one GET saying what it does, and one
// POST that answers a question. There is deliberately no endpoint here
// that changes anything — not "assistant/pay", not "assistant/confirm".
// Actions live on the payments routes, behind the person's own
// confirmation, and the assistant can only link to the screen.

export async function assistantRoutes(
  app: FastifyInstance,
  opts: { pool: Pool; assistantModel?: AssistantModel }
) {
  const { pool } = opts;

  app.get("/api/v1/assistant", { onRequest: authenticate }, async (_request, reply) =>
    reply.send({ assistant: assistantCapabilities() })
  );

  app.post(
    "/api/v1/assistant/ask",
    {
      onRequest: authenticate,
      schema: {
        body: {
          type: "object",
          required: ["question"],
          properties: {
            question: { type: "string", minLength: 1, maxLength: MAX_QUESTION_LENGTH },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { question } = request.body as { question: string };
      try {
        const answer = await askAssistant(
          { pool, model: opts.assistantModel },
          { userId: request.user!.sub, question }
        );
        return reply.send({ assistant: answer });
      } catch (err) {
        if (err instanceof AssistantQuestionError) {
          return reply.status(400).send({
            code: "INVALID_QUESTION",
            message: err.message,
            requestId: request.id,
          });
        }
        throw err;
      }
    }
  );
}
