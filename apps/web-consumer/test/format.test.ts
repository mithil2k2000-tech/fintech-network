import { describe, it, expect } from "vitest";
import {
  dayLabel,
  expiresInLabel,
  failureMessage,
  firstNameFromEmail,
  groupByDay,
} from "../src/lib/format";

describe("firstNameFromEmail", () => {
  it.each([
    ["alex.smith@example.com", "Alex"],
    ["SAM@example.com", "Sam"],
    ["jo_bloggs@example.com", "Jo"],
    ["alice-pay.1789@example.com", "Alice"],
    ["123@example.com", "123"],
    ["", "there"],
  ])("%s -> %s", (email, name) => {
    expect(firstNameFromEmail(email)).toBe(name);
  });
});

describe("dayLabel / groupByDay", () => {
  const now = new Date(2026, 8, 17, 15, 0); // 17 Sep 2026, local time

  it("labels today, yesterday and older days", () => {
    expect(dayLabel(new Date(2026, 8, 17, 0, 5).toISOString(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 8, 16, 23, 59).toISOString(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 8, 1, 12).toISOString(), now)).toBe("1 September 2026");
  });

  it("groups consecutive items by day and keeps order", () => {
    const items = [
      new Date(2026, 8, 17, 14).toISOString(),
      new Date(2026, 8, 17, 9).toISOString(),
      new Date(2026, 8, 16, 20).toISOString(),
      new Date(2026, 8, 10, 8).toISOString(),
    ];
    const groups = groupByDay(items, (d) => d, now);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
      ["10 September 2026", 1],
    ]);
  });
});

describe("failureMessage", () => {
  it("explains known failures in plain English", () => {
    expect(failureMessage("INSUFFICIENT_FUNDS")).toMatch(/enough money/);
    expect(failureMessage("PROVIDER_DECLINED: Simulated bank decline")).toBe("The payment was declined.");
  });

  it("never shows raw codes for unknown failures", () => {
    const msg = failureMessage("PROCESSING_ERROR");
    expect(msg).not.toMatch(/PROCESSING_ERROR/);
    expect(msg).toMatch(/No money was taken/);
  });

  it("explains a declined request without blaming the payer", () => {
    expect(failureMessage("PAYMENT_REQUEST_DECLINED")).toMatch(/declined/);
  });
});

describe("expiresInLabel", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  const inMs = (ms: number) => new Date(now.getTime() + ms).toISOString();

  it("counts down in the unit that reads best", () => {
    expect(expiresInLabel(inMs(30_000), now)).toBe("Expires in 30 sec");
    expect(expiresInLabel(inMs(25 * 60_000), now)).toBe("Expires in 25 min");
    expect(expiresInLabel(inMs(5 * 3_600_000), now)).toBe("Expires in 5 hours");
    // A request sent to a person lasts a week — not 168 hours.
    expect(expiresInLabel(inMs(7 * 24 * 3_600_000), now)).toBe("Expires in 7 days");
  });

  it("says so once it's gone", () => {
    expect(expiresInLabel(inMs(-1), now)).toBe("Expired");
    expect(expiresInLabel(inMs(0), now)).toBe("Expired");
  });
});
