// What this deployment is allowed to do, decided in one place.
//
// Phase 14 (security hardening). Two jobs:
//
//   1. Read the environment once, so no route reads process.env on its
//      own and no default is spelled twice.
//   2. Refuse to start a production deployment that is only configured
//      like a development one. The dangerous failure here isn't a crash
//      — it's a deployment that quietly runs with the sample secret and
//      the localhost origins, looking fine.
//
// The checking is a pure function over an environment object, so it can
// be tested without setting real environment variables.

/** The sample value in .env.example. It must never reach production. */
export const DEV_JWT_SECRET = "dev-only-change-me";

/** Minimum length for a real signing secret. */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Dev-mode origins: the three app shells, plus the two ports the
 * end-to-end tests run the apps on. In production this is not a default
 * — `ALLOWED_ORIGINS` must say.
 */
export const DEV_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://localhost:5180",
  "http://localhost:5181",
  "http://localhost:5182",
] as const;

export interface AppConfig {
  production: boolean;
  /** Origins allowed by CORS, and the only origins a cookie is honoured from. */
  allowedOrigins: string[];
  /** https-only cookies. Always true in production; opt-in elsewhere. */
  secureCookies: boolean;
  rateLimitPerMinute: number;
  authRateLimitPerMinute: number;
  writeRateLimitPerMinute: number;
  /** How long a started payment may sit unconfirmed. */
  approvalTtlMinutes: number;
  /** Failed sign-ins for one account before it's held off, per window. */
  loginFailureLimit: number;
  loginFailureWindowMinutes: number;
  /** Failed recipient lookups per payer, per hour, before we stop answering. */
  recipientLookupFailureLimit: number;
}

export class ConfigError extends Error {}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function originList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Builds the config, and throws if a production environment is missing
 * something it can't safely default. Called once at startup — failing
 * here is the point: a deployment that can't be configured safely
 * shouldn't come up at all.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const production = env.NODE_ENV === "production";
  const configuredOrigins = originList(env.ALLOWED_ORIGINS);
  const problems: string[] = [];

  if (production) {
    const secret = env.JWT_SECRET ?? "";
    if (secret.length === 0) {
      problems.push("JWT_SECRET is not set");
    } else if (secret === DEV_JWT_SECRET) {
      problems.push("JWT_SECRET is still the sample value from .env.example");
    } else if (secret.length < MIN_JWT_SECRET_LENGTH) {
      problems.push(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
    }
    if (configuredOrigins.length === 0) {
      problems.push("ALLOWED_ORIGINS must list this deployment's app origins");
    }
    for (const origin of configuredOrigins) {
      if (origin.startsWith("http://")) {
        problems.push(`ALLOWED_ORIGINS contains a plain-http origin: ${origin}`);
      }
      if (origin === "*") {
        problems.push("ALLOWED_ORIGINS must not be a wildcard");
      }
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(
      `Refusing to start: this looks like a production deployment but ${problems.join("; ")}.`
    );
  }

  return {
    production,
    allowedOrigins: configuredOrigins.length > 0 ? configuredOrigins : [...DEV_ORIGINS],
    // https-only in production, and a staging deployment served over
    // https can opt in. Nothing can turn it off in production: the
    // override only ever adds the flag.
    secureCookies: production || env.SECURE_COOKIES === "true",
    rateLimitPerMinute: positiveInt(env.RATE_LIMIT_PER_MINUTE, 100),
    authRateLimitPerMinute: positiveInt(env.AUTH_RATE_LIMIT_PER_MINUTE, 10),
    writeRateLimitPerMinute: positiveInt(env.WRITE_RATE_LIMIT_PER_MINUTE, 30),
    approvalTtlMinutes: positiveInt(env.PAYMENT_APPROVAL_TTL_MINUTES, 15),
    loginFailureLimit: positiveInt(env.LOGIN_FAILURE_LIMIT, 10),
    loginFailureWindowMinutes: positiveInt(env.LOGIN_FAILURE_WINDOW_MINUTES, 15),
    recipientLookupFailureLimit: positiveInt(env.RECIPIENT_LOOKUP_FAILURE_LIMIT, 10),
  };
}
