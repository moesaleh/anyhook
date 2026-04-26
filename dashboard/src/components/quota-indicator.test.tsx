import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QuotaIndicator } from "./quota-indicator";

// Stub the API client at the module level. Vitest handles ESM module mocks
// via vi.mock; we spy on fetchQuotas and return canned values per test.
vi.mock("@/lib/api", () => ({
  fetchQuotas: vi.fn(),
}));

import { fetchQuotas } from "@/lib/api";

describe("QuotaIndicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing on first paint (before fetch resolves)", () => {
    (fetchQuotas as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {}) // never resolves
    );
    const { container } = render(<QuotaIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it("displays usage / limit after fetch resolves", async () => {
    (fetchQuotas as ReturnType<typeof vi.fn>).mockResolvedValue({
      subscriptions: { used: 12, limit: 100 },
      api_keys: { used: 3, limit: 10 },
    });
    render(<QuotaIndicator />);
    await waitFor(() => {
      expect(screen.getByText("12 / 100")).toBeInTheDocument();
      expect(screen.getByText("3 / 10")).toBeInTheDocument();
    });
    expect(screen.getByText("Subscriptions")).toBeInTheDocument();
    expect(screen.getByText("API keys")).toBeInTheDocument();
  });

  it("renders nothing when the fetch throws (silent failure)", async () => {
    (fetchQuotas as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const { container } = render(<QuotaIndicator />);
    // Give the rejection a tick to flush
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(container.firstChild).toBeNull();
  });

  it("renders zero/zero without dividing by zero", async () => {
    (fetchQuotas as ReturnType<typeof vi.fn>).mockResolvedValue({
      subscriptions: { used: 0, limit: 0 },
      api_keys: { used: 0, limit: 10 },
    });
    render(<QuotaIndicator />);
    await waitFor(() => {
      expect(screen.getByText("0 / 0")).toBeInTheDocument();
    });
  });
});
