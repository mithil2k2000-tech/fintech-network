import { describe, it, expect } from "vitest";
import {
  generateRequestCode,
  generateRequestToken,
  parseRequestKey,
} from "../src/modules/paymentRequests/codes.js";
import { effectiveStatus } from "../src/modules/paymentRequests/index.js";

describe("request codes and tokens", () => {
  it("codes are REQ- plus 8 unambiguous characters and don't repeat", () => {
    const codes = Array.from({ length: 5_000 }, generateRequestCode);
    for (const c of codes) expect(c).toMatch(/^REQ-[A-HJ-NP-Z2-9]{8}$/);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("tokens are 43 url-safe characters", () => {
    const tokens = Array.from({ length: 1_000 }, generateRequestToken);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe("parseRequestKey", () => {
  const token = generateRequestToken();

  it("recognises a token", () => {
    expect(parseRequestKey(token)).toEqual({ token });
    expect(parseRequestKey(`  ${token} `)).toEqual({ token });
  });

  it("recognises a code however it was typed", () => {
    expect(parseRequestKey("REQ-7KQ2MX9T")).toEqual({ code: "REQ-7KQ2MX9T" });
    expect(parseRequestKey("req-7kq2mx9t")).toEqual({ code: "REQ-7KQ2MX9T" });
    expect(parseRequestKey("REQ-7KQ2 MX9T")).toEqual({ code: "REQ-7KQ2MX9T" });
  });

  it("recognises a request id, however it was cased", () => {
    const id = "3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
    expect(parseRequestKey(id)).toEqual({ id });
    expect(parseRequestKey(id.toUpperCase())).toEqual({ id });
    expect(parseRequestKey(` ${id} `)).toEqual({ id });
  });

  it.each([
    "",
    "REQ-7KQ2MX9",
    "REQ-7KQ2MX9TT",
    "REQ-0KQ2MX9T", // 0 is never used in codes
    "' or 1=1 --",
    `${token}x`,
    "https://example.com/pay/r/abc",
    "3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5", // an id a character short
    "3f1a2b4c5d6e4f708a9b0c1d2e3f4a5b", // and one without its dashes
  ])("rejects %j", (raw) => {
    expect(parseRequestKey(raw)).toBeNull();
  });
});

describe("effectiveStatus", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  const later = new Date("2026-09-17T12:30:00Z");
  const earlier = new Date("2026-09-17T11:30:00Z");

  it("reports an open request past its expiry as EXPIRED", () => {
    expect(effectiveStatus({ status: "OPEN", expires_at: earlier }, now)).toBe("EXPIRED");
    expect(effectiveStatus({ status: "OPEN", expires_at: now }, now)).toBe("EXPIRED");
    expect(effectiveStatus({ status: "OPEN", expires_at: later }, now)).toBe("OPEN");
  });

  it("keeps a settled status as it is, even after expiry", () => {
    expect(effectiveStatus({ status: "PAID", expires_at: earlier }, now)).toBe("PAID");
    expect(effectiveStatus({ status: "CANCELLED", expires_at: earlier }, now)).toBe("CANCELLED");
    expect(effectiveStatus({ status: "DECLINED", expires_at: earlier }, now)).toBe("DECLINED");
  });
});
