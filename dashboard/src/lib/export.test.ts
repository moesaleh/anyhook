import { describe, it, expect } from "vitest";
import {
  exportAsJson,
  exportAsCsv,
  csvField,
  toExportRow,
} from "./export";
import type { Subscription } from "./api";

const sample: Subscription = {
  subscription_id: "11111111-2222-3333-4444-555555555555",
  organization_id: "org-1",
  connection_type: "graphql",
  args: {
    endpoint_url: "wss://api.example.com/graphql",
    query: "subscription { x }",
    headers: { Authorization: "Bearer x" },
  },
  webhook_url: "https://hooks.example.com/in",
  status: "active",
  created_at: "2026-04-01T00:00:00Z",
};

describe("toExportRow", () => {
  it("strips server-only fields", () => {
    const row = toExportRow(sample);
    expect(row).not.toHaveProperty("organization_id");
    expect(row).not.toHaveProperty("created_at");
    expect(row.subscription_id).toBe(sample.subscription_id);
  });
});

describe("exportAsJson", () => {
  it("produces valid JSON parseable to an array", () => {
    const out = exportAsJson([sample, sample]);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].connection_type).toBe("graphql");
  });

  it("preserves nested args", () => {
    const out = exportAsJson([sample]);
    const parsed = JSON.parse(out);
    expect(parsed[0].args.headers.Authorization).toBe("Bearer x");
  });
});

describe("exportAsCsv", () => {
  it("starts with a header row", () => {
    const out = exportAsCsv([sample]);
    const firstLine = out.split("\n")[0];
    expect(firstLine).toBe(
      "subscription_id,connection_type,webhook_url,args,status"
    );
  });

  it("produces one data row per subscription", () => {
    const out = exportAsCsv([sample, sample]);
    expect(out.split("\n")).toHaveLength(3); // header + 2 rows
  });

  it("JSON-encodes the args column with proper CSV quoting", () => {
    const out = exportAsCsv([sample]);
    expect(out).toContain('"{""endpoint_url""');
  });
});

describe("csvField (RFC 4180 quoting)", () => {
  it.each([
    ["plain", "plain"],
    ["", ""],
    [null, ""],
    [undefined, ""],
    [42, "42"],
    ['has "quotes"', '"has ""quotes"""'],
    ["has, comma", '"has, comma"'],
    ["has\nnewline", '"has\nnewline"'],
    ["has\rcr", '"has\rcr"'],
  ])("csvField(%j) === %j", (input, expected) => {
    expect(csvField(input as string | number | null | undefined)).toBe(expected);
  });
});
