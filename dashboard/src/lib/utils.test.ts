import { describe, it, expect } from "vitest";
import { cn, formatDate, truncate, timeAgo, formatUptime } from "./utils";

describe("cn", () => {
  it("joins class strings with spaces", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("skips falsy values", () => {
    expect(cn("a", false && "b", null, undefined, "c")).toBe("a c");
  });

  it("returns empty string for all-falsy input", () => {
    expect(cn(false, null, undefined)).toBe("");
  });

  it("handles object syntax (clsx feature)", () => {
    expect(cn({ a: true, b: false, c: true })).toBe("a c");
  });
});

describe("truncate", () => {
  it("returns original when shorter than limit", () => {
    expect(truncate("hi", 10)).toBe("hi");
  });

  it("returns original when exactly at limit", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("appends ellipsis when longer than limit", () => {
    expect(truncate("hello world", 5)).toBe("hello…");
  });

  it("uses unicode ellipsis (…), not three dots", () => {
    const out = truncate("abcdefghijk", 3);
    expect(out).toBe("abc…");
    expect(out).not.toContain("...");
  });
});

describe("timeAgo", () => {
  it('returns "just now" for sub-5-second deltas', () => {
    expect(timeAgo(new Date())).toBe("just now");
  });

  it("returns Ns for 5-59 second deltas", () => {
    const d = new Date(Date.now() - 30 * 1000);
    expect(timeAgo(d)).toBe("30s ago");
  });

  it("returns Nm for sub-hour deltas", () => {
    const d = new Date(Date.now() - 5 * 60 * 1000);
    expect(timeAgo(d)).toBe("5m ago");
  });

  it("returns Nh for sub-day deltas", () => {
    const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
    expect(timeAgo(d)).toBe("3h ago");
  });

  it("returns Nd for multi-day deltas", () => {
    const d = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    expect(timeAgo(d)).toBe("5d ago");
  });
});

describe("formatUptime", () => {
  it("seconds when < 1 minute", () => {
    const d = new Date(Date.now() - 30 * 1000);
    expect(formatUptime(d.toISOString())).toBe("30s");
  });

  it("minutes when < 1 hour", () => {
    const d = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatUptime(d.toISOString())).toBe("5m");
  });

  it("hours + minutes when < 1 day", () => {
    const d = new Date(Date.now() - (3 * 60 * 60 * 1000 + 15 * 60 * 1000));
    expect(formatUptime(d.toISOString())).toBe("3h 15m");
  });

  it("days + hours when ≥ 1 day", () => {
    const d = new Date(Date.now() - (5 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000));
    expect(formatUptime(d.toISOString())).toBe("5d 3h");
  });
});

describe("formatDate", () => {
  it("returns a non-empty string for a valid ISO date", () => {
    const out = formatDate("2024-01-15T10:30:00Z");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("includes the year", () => {
    const out = formatDate("2024-01-15T10:30:00Z");
    expect(out).toContain("2024");
  });

  it("includes the abbreviated month name", () => {
    const out = formatDate("2024-01-15T10:30:00Z");
    // Locale-independent assertion: contains "Jan" (en-US is hardcoded)
    expect(out).toContain("Jan");
  });
});
