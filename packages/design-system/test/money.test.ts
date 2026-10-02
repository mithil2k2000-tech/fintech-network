import { describe, it, expect } from "vitest";
import { formatMoney, parseMoneyInput } from "../src/money.js";

describe("formatMoney", () => {
  it.each([
    [0, "£0.00"],
    [5, "£0.05"],
    [1250, "£12.50"],
    [50_000, "£500.00"],
    [123_456_789, "£1,234,567.89"],
    [-850, "−£8.50"],
  ])("formats %i as %s", (minor, expected) => {
    expect(formatMoney(minor)).toBe(expected);
  });

  it("can always show a sign", () => {
    expect(formatMoney(700, { sign: "always" })).toBe("+£7.00");
    expect(formatMoney(-700, { sign: "always" })).toBe("−£7.00");
    expect(formatMoney(0, { sign: "always" })).toBe("£0.00");
  });

  it("is exact where floats aren't (0.1 + 0.2)", () => {
    expect(formatMoney(10 + 20)).toBe("£0.30");
    expect(formatMoney(1_000_000_000_001)).toBe("£10,000,000,000.01");
  });

  it("refuses non-integer input", () => {
    expect(() => formatMoney(12.5)).toThrow();
    expect(() => formatMoney(Number.NaN)).toThrow();
  });
});

describe("parseMoneyInput", () => {
  it.each([
    ["12", 1200],
    ["12.5", 1250],
    ["12.50", 1250],
    ["12.", 1200],
    ["0.01", 1],
    ["£8.50", 850],
    [" 1,250.00 ", 125_000],
    ["0.29", 29], // 0.29 * 100 = 28.999999999999996 as a float
    ["19.99", 1999],
  ])("reads %j as %i pence", (raw, expected) => {
    expect(parseMoneyInput(raw)).toEqual({ ok: true, minorUnits: expected });
  });

  it.each([
    ["", "Enter an amount"],
    ["   ", "Enter an amount"],
    ["-5", "Amount can't be negative"],
    ["0", "Amount must be more than £0.00"],
    ["0.00", "Amount must be more than £0.00"],
    ["12.505", "Use at most 2 decimal places"],
    ["abc", "Enter a valid amount, like 12.50"],
    ["1e3", "Enter a valid amount, like 12.50"],
    ["12.5.0", "Enter a valid amount, like 12.50"],
    ["99999999", "Enter a valid amount, like 12.50"],
  ])("rejects %j", (raw, error) => {
    expect(parseMoneyInput(raw)).toEqual({ ok: false, error });
  });
});
