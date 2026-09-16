import { describe, expect, it } from "vitest";
import { isPlausibleEmail } from "../validation";

describe("isPlausibleEmail", () => {
  it("accepts a normal email", () => {
    expect(isPlausibleEmail("arjun.rao@wekancode.com")).toBe(true);
  });

  it("trims surrounding whitespace before checking", () => {
    expect(isPlausibleEmail("  arjun.rao@wekancode.com  ")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isPlausibleEmail("")).toBe(false);
    expect(isPlausibleEmail("   ")).toBe(false);
  });

  it("rejects a string with no @", () => {
    expect(isPlausibleEmail("not-an-email")).toBe(false);
  });

  it("rejects a string with no domain dot", () => {
    expect(isPlausibleEmail("user@localhost")).toBe(false);
  });

  it("rejects a string with spaces", () => {
    expect(isPlausibleEmail("us er@example.com")).toBe(false);
  });

  it("rejects an implausibly long string", () => {
    expect(isPlausibleEmail(`${"a".repeat(255)}@example.com`)).toBe(false);
  });
});
