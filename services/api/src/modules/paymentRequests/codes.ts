import { randomBytes } from "node:crypto";

// No 0/O or 1/I, so a code can be read out or typed without mistakes.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** e.g. REQ-7KQ2MX9T — 40 bits. Guessing is slowed by rate limiting. */
export function generateRequestCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `REQ-${out}`;
}

/** What the QR carries. 256 bits, URL-safe, 43 characters. */
export function generateRequestToken(): string {
  return randomBytes(32).toString("base64url");
}

export const CODE_PATTERN = /^REQ-[A-HJ-NP-Z2-9]{8}$/;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RequestKey = { code: string } | { token: string } | { id: string };

/**
 * Accepts a code (any case, spaces ignored), a QR token, or a request id.
 * Ids are how a request sent to a named person is opened — the recipient
 * already has it from their inbox. Being able to name a request is not
 * permission to see it: who may read what is decided in index.ts.
 */
export function parseRequestKey(raw: string): RequestKey | null {
  const trimmed = raw.trim();
  if (TOKEN_PATTERN.test(trimmed)) return { token: trimmed };
  if (ID_PATTERN.test(trimmed)) return { id: trimmed.toLowerCase() };
  const code = trimmed.toUpperCase().replace(/\s+/g, "");
  if (CODE_PATTERN.test(code)) return { code };
  return null;
}
