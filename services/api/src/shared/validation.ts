// Small, shared request-validation pieces so every route spells a UUID or
// a page size the same way. Query strings aren't type-coerced (see
// buildApp), so numeric query params are validated as digit strings and
// parsed by the handler.
export const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

export const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const UUID_RE = new RegExp(UUID_PATTERN);

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}
