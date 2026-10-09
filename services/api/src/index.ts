import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { getHealthStatus, getReadiness } from "./health.js";
import { MetricsRegistry, routeLabel } from "./observability/metrics.js";
import { loadConfig, type AppConfig } from "./config.js";
import { getPool, closePool } from "./db.js";
import { identityRoutes } from "./modules/identity/routes.js";
import { authenticate, requireRole } from "./modules/identity/middleware.js";
import { usersRoutes } from "./modules/users/routes.js";
import { ledgerRoutes } from "./modules/ledger/routes.js";
import { paymentsRoutes } from "./modules/payments/routes.js";
import { receiptsRoutes } from "./modules/receipts/routes.js";
import { transactionsRoutes } from "./routes/transactions.js";
import { paymentRequestsRoutes } from "./modules/paymentRequests/routes.js";
import { billSplitsRoutes } from "./modules/billSplits/routes.js";
import { merchantsRoutes } from "./modules/merchants/routes.js";
import { rewardsRoutes } from "./modules/rewards/routes.js";
import { assistantRoutes } from "./modules/ai/routes.js";
import { adminRoutes } from "./modules/admin/routes.js";
import type { AssistantModel } from "./modules/ai/index.js";
import { grantCashback } from "./modules/rewards/index.js";
import { RulesRiskEvaluator } from "./modules/risk/index.js";
import { markPaymentRequestPaid } from "./modules/paymentRequests/index.js";
import {
  SimulatedPaymentProvider,
  type PaymentCompletionHook,
  type PaymentProvider,
  type PaymentsDeps,
  type RiskEvaluator,
} from "./modules/payments/index.js";

// Domain modules are registered here as they gain routes. See spec §17
// (Backend Architecture) for the full module list and boundary rules.

/**
 * Swappable collaborators. Defaults are the prototype implementations;
 * tests (and later phases) pass their own without touching any route or
 * service code. This is the one place implementations get chosen.
 */
export interface AppOptions {
  paymentProvider?: PaymentProvider;
  riskEvaluator?: RiskEvaluator;
  /**
   * Who writes the assistant's prose. Defaults to the deterministic
   * answerer; whatever goes here can only choose words (see
   * modules/ai/model.ts), never figures, decisions or actions.
   */
  assistantModel?: AssistantModel;
  logger?: boolean;
  /**
   * Everything the environment decides (origins, cookie flags, limits,
   * timeouts). Built by loadConfig() at startup; a test can pass its
   * own without setting environment variables.
   */
  config?: AppConfig;
  /** Requests per minute per client, across the API. Env: RATE_LIMIT_PER_MINUTE (default 100). */
  rateLimitPerMinute?: number;
  /** Sign-up / sign-in attempts per minute per client. Env: AUTH_RATE_LIMIT_PER_MINUTE (default 10). */
  authRateLimitPerMinute?: number;
  /** Money-moving writes per minute per client. Env: WRITE_RATE_LIMIT_PER_MINUTE (default 30). */
  writeRateLimitPerMinute?: number;
  /** Extra hooks run when a payment completes (after the built-in ones). */
  extraCompletionHooks?: PaymentCompletionHook[];
  /** Traffic metrics. A test can pass its own to read them back. */
  metrics?: MetricsRegistry;
}

/**
 * How many proxies sit between the internet and this process (env
 * TRUST_PROXY_HOPS). Behind a load balancer every request arrives from
 * the load balancer's address, so without this the per-client rate
 * limits become one limit shared by everybody. Unset means none: the
 * forwarded-for header is ignored, because trusting it with no proxy in
 * front would let any caller choose their own address.
 */
function trustProxyHops(): number | false {
  const hops = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? "", 10);
  return Number.isSafeInteger(hops) && hops > 0 ? hops : false;
}

export function buildApp(options: AppOptions = {}) {
  const app = Fastify({
    trustProxy: trustProxyHops(),
    logger:
      options.logger === false
        ? false
        : {
            level: process.env.LOG_LEVEL ?? "info",
            // Nothing that identifies a session may reach a log line.
            // Pino's default request serializer already drops headers,
            // and this makes that a rule rather than a default: a
            // credential in a log is a credential in a backup, a
            // screenshot and a support ticket (spec §24, §26).
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "res.headers['set-cookie']",
                "*.password",
                "*.token",
              ],
              censor: "[redacted]",
            },
          },
    ajv: {
      customOptions: {
        // Strict input for a financial API: "2000" is not a number and an
        // unexpected field is an error, not something to silently drop.
        // (Fastify's defaults coerce types and strip unknown properties.)
        // Query-string schemas added later must declare their own
        // conversions explicitly, since nothing is coerced for them.
        coerceTypes: false,
        removeAdditional: false,
      },
    },
  });
  const pool = getPool();
  const metrics = options.metrics ?? new MetricsRegistry();
  // One read of the environment, and the place a production deployment
  // is refused if it's only configured like a development one (§14).
  const config = options.config ?? loadConfig();
  app.decorate("appConfig", config);

  const paymentProvider = options.paymentProvider ?? new SimulatedPaymentProvider();
  // The deterministic rules engine (spec §12). A test can pass its own
  // evaluator, but nothing that runs for real gets a placeholder.
  const riskEvaluator = options.riskEvaluator ?? new RulesRiskEvaluator(pool);
  const rateLimitPerMinute = options.rateLimitPerMinute ?? config.rateLimitPerMinute;
  const authRateLimitPerMinute = options.authRateLimitPerMinute ?? config.authRateLimitPerMinute;
  const writeRateLimitPerMinute = options.writeRateLimitPerMinute ?? config.writeRateLimitPerMinute;

  app.register(helmet);
  app.register(cookie);
  app.register(cors, {
    // The apps this deployment serves, and nothing else. In production
    // ALLOWED_ORIGINS must say what they are; there is no default there.
    origin: config.allowedOrigins,
    // The apps send their session cookie, so the browser needs to be
    // told the response may be read by them.
    credentials: true,
  });
  app.register(rateLimit, { max: rateLimitPerMinute, timeWindow: "1 minute" });

  // One error shape for everything (spec §19): { code, message, requestId }.
  // Unexpected errors are logged in full but never echoed to the client.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) {
      return reply.status(400).send({
        code: "VALIDATION_ERROR",
        message: error.message,
        requestId: request.id,
      });
    }
    const status = error.statusCode ?? 500;
    if (status < 500) {
      return reply.status(status).send({
        code: error.code ?? "REQUEST_ERROR",
        message: error.message,
        requestId: request.id,
      });
    }
    request.log.error(
      { err: error, route: routeLabel(request.routeOptions?.url, request.url) },
      "unhandled error"
    );
    metrics.errors.increment({
      route: routeLabel(request.routeOptions?.url, request.url),
    });
    return reply.status(500).send({
      code: "INTERNAL_ERROR",
      message: "Something went wrong",
      requestId: request.id,
    });
  });

  // Liveness: is this process alive? It must not touch the database —
  // if it did, a database blip would restart every instance at once and
  // turn a recoverable outage into a stampede (spec §24).
  app.get("/health", async () => getHealthStatus());

  // Readiness: should traffic come here? This one must touch it.
  app.get("/health/ready", async (_request, reply) => {
    const readiness = await getReadiness(pool);
    return reply.status(readiness.status === "ready" ? 200 : 503).send(readiness);
  });

  // Traffic, in Prometheus text format. Money and decisions are NOT
  // counted here — a counter that resets when a process restarts is a
  // lie about a ledger. Those are read live from the tables that own
  // them, through /api/v1/admin/overview.
  app.get("/metrics", async (_request, reply) =>
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").send(metrics.render())
  );

  // One pair of hooks, every route, no per-route bookkeeping to forget.
  app.addHook("onResponse", async (request, reply) => {
    const route = routeLabel(request.routeOptions?.url, request.url);
    const labels = { method: request.method, route };
    metrics.requests.increment({ ...labels, status: String(reply.statusCode) });
    // Fastify measures in milliseconds; Prometheus convention is
    // seconds, and mixing the two is how dashboards end up wrong.
    metrics.duration.observe(reply.elapsedTime / 1000, labels);
  });

  app.get("/api/v1", async () => ({
    name: process.env.APP_NAME ?? "FinTech Network",
    version: "v1",
    status: "prototype — simulated financial infrastructure, no real money",
  }));

  app.register(identityRoutes, {
    pool,
    authRateLimitPerMinute,
    secureCookies: config.secureCookies,
    loginFailureLimit: config.loginFailureLimit,
    loginFailureWindowMinutes: config.loginFailureWindowMinutes,
  });
  app.register(usersRoutes, { pool });
  app.register(ledgerRoutes, { pool });
  // Payment completion hooks: every module that reacts to a completed
  // payment is listed here, in order. Each runs inside the transaction
  // that completes the payment; cashback guards itself with a savepoint
  // so a reward can never cost someone their payment.
  const paymentsDeps: PaymentsDeps = {
    pool,
    provider: paymentProvider,
    riskEvaluator,
    completionHooks: [markPaymentRequestPaid, grantCashback, ...(options.extraCompletionHooks ?? [])],
    writeRateLimitPerMinute,
    approvalTtlMinutes: config.approvalTtlMinutes,
    recipientLookupFailureLimit: config.recipientLookupFailureLimit,
  };

  app.register(paymentsRoutes, paymentsDeps);
  app.register(paymentRequestsRoutes, paymentsDeps);
  // Splits sit on top of payment requests: they make them, they never
  // move money themselves.
  app.register(billSplitsRoutes, { pool, writeRateLimitPerMinute });
  app.register(merchantsRoutes, { pool, writeRateLimitPerMinute });
  app.register(rewardsRoutes, { pool });
  // The assistant reads and explains. It has no route that changes
  // anything, and nothing it can reach writes (spec §13).
  app.register(assistantRoutes, { pool, assistantModel: options.assistantModel });
  app.register(receiptsRoutes, { pool });
  app.register(transactionsRoutes, { pool });

  // The operations view, and the RBAC demo route it grew out of.
  app.register(adminRoutes, { pool });

  app.addHook("onClose", async () => {
    await closePool();
  });

  return app;
}

async function main() {
  const app = buildApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
}

// Only auto-start when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
