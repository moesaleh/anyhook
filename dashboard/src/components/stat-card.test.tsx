import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Radio } from "lucide-react";
import { StatCard } from "./stat-card";

describe("StatCard", () => {
  it("renders title and value", () => {
    render(<StatCard title="Total" value={42} icon={Radio} />);
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("renders string values verbatim (e.g. '—' placeholder)", () => {
    render(<StatCard title="Loading" value="—" icon={Radio} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders description when provided", () => {
    render(<StatCard title="x" value={1} icon={Radio} description="foo bar" />);
    expect(screen.getByText("foo bar")).toBeInTheDocument();
  });

  it("does NOT render description block when omitted", () => {
    const { container } = render(<StatCard title="x" value={1} icon={Radio} />);
    // Only one paragraph in the description position would mean a description div
    // present. Easiest check: no element with class containing "neutral-500 mt-1"
    // — but coupling tests to classnames is fragile. Instead just count <p>:
    const ps = container.querySelectorAll("p");
    // title (1) + value (1) = 2; no description
    expect(ps.length).toBe(2);
  });
});
