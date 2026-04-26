import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LiveIndicator } from "./live-indicator";

describe("LiveIndicator", () => {
  it("shows 'Live' when polling", () => {
    render(<LiveIndicator lastUpdated={null} isPolling={true} intervalMs={10000} />);
    expect(screen.getByText(/Live/)).toBeInTheDocument();
  });

  it("shows 'Paused' when not polling", () => {
    render(<LiveIndicator lastUpdated={null} isPolling={false} intervalMs={10000} />);
    expect(screen.getByText(/Paused/)).toBeInTheDocument();
  });

  it("shows interval in seconds when polling", () => {
    render(<LiveIndicator lastUpdated={null} isPolling={true} intervalMs={30000} />);
    expect(screen.getByText(/30s/)).toBeInTheDocument();
  });

  it("shows 'Updated <ago>' when lastUpdated is set", () => {
    const date = new Date(Date.now() - 5 * 60 * 1000);
    render(<LiveIndicator lastUpdated={date} isPolling={true} intervalMs={10000} />);
    expect(screen.getByText(/Updated 5m ago/)).toBeInTheDocument();
  });

  it("uses aria-live=polite for screen reader updates", () => {
    const { container } = render(
      <LiveIndicator lastUpdated={null} isPolling={true} intervalMs={10000} />
    );
    expect(container.querySelector('[aria-live="polite"]')).toBeInTheDocument();
  });
});
