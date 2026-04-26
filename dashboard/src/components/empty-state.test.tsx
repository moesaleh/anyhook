import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("shows the headline + body copy", () => {
    render(<EmptyState />);
    expect(screen.getByText("No subscriptions yet")).toBeInTheDocument();
    expect(screen.getByText(/Create your first subscription/)).toBeInTheDocument();
  });

  it("links to /subscriptions/new", () => {
    render(<EmptyState />);
    const link = screen.getByRole("link", { name: /Create Subscription/ });
    expect(link).toHaveAttribute("href", "/subscriptions/new");
  });
});
