import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./status-badge";

describe("StatusBadge", () => {
  it("shows 'Connected' when status=active and connected=true", () => {
    render(<StatusBadge status="active" connected={true} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("shows 'Disconnected' when status=active and connected=false", () => {
    render(<StatusBadge status="active" connected={false} />);
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });

  it("shows 'Error' for error status regardless of connected", () => {
    render(<StatusBadge status="error" connected={true} />);
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("falls back to capitalized status when unknown", () => {
    render(<StatusBadge status="unknown" />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("when connected is undefined, uses status verbatim (label transforms)", () => {
    render(<StatusBadge status="active" />);
    // active label is "Connected" per the switch
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });
});
