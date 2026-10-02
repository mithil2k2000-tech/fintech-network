import { describe, it, expect } from "vitest";
import {
  REQUEST_STATUS_LABELS,
  dayLabel,
  expiresInLabel,
  firstNameFromEmail,
  groupByDay,
} from "../src/format.js";

// These helpers decide what a person reads on a screen in both apps, so
// they're tested here, where they live, rather than in either app.

describe("firstNameFromEmail", () => {
  it("takes a usable first name out of an address", () => {
    expect(firstNameFromEmail("alex.smith@example.com")).toBe("Alex");
    expect(firstNameFromEmail("ALEX@example.com")).toBe("Alex");
    expect(firstNameFromEmail("alex_smith99@example.com")).toBe("Alex");
    expect(firstNameFromEmail("alex+shopping@example.com")).toBe("Alex");
  });

  it("falls back to something sayable", () => {
    expect(firstNameFromEmail("")).toBe("there");
    expect(firstNameFromEmail("@example.com")).toBe("there");
  });
});

describe("dayLabel / groupByDay", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  const iso = (d: string) => new Date(d).toISOString();

  // Days are the reader's local days, so these stay away from midnight:
  // 23:00 UTC is already tomorrow in London.
  it("says Today and Yesterday before it says a date", () => {
    expect(dayLabel(iso("2026-09-17T09:00:00Z"), now)).toBe("Today");
    expect(dayLabel(iso("2026-09-16T12:00:00Z"), now)).toBe("Yesterday");
    expect(dayLabel(iso("2026-09-10T09:00:00Z"), now)).toMatch(/10 September 2026/);
  });

  it("groups by day without reordering anything", () => {
    const items = [
      { at: iso("2026-09-17T11:00:00Z"), n: 1 },
      { at: iso("2026-09-17T09:00:00Z"), n: 2 },
      { at: iso("2026-09-16T18:00:00Z"), n: 3 },
    ];
    const groups = groupByDay(items, (i) => i.at, now);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday"]);
    expect(groups[0].items.map((i) => i.n)).toEqual([1, 2]);
    expect(groups[1].items.map((i) => i.n)).toEqual([3]);
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

describe("REQUEST_STATUS_LABELS", () => {
  it("has plain words for every status a request can be in", () => {
    for (const status of ["OPEN", "PAID", "CANCELLED", "DECLINED", "EXPIRED"]) {
      expect(REQUEST_STATUS_LABELS[status]).toBeTruthy();
      expect(REQUEST_STATUS_LABELS[status]).not.toMatch(/[A-Z]{2,}/);
    }
  });
});
