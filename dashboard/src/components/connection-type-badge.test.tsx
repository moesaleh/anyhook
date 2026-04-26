import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectionTypeBadge } from "./connection-type-badge";

describe("ConnectionTypeBadge", () => {
  it("renders 'GraphQL' for type=graphql", () => {
    render(<ConnectionTypeBadge type="graphql" />);
    expect(screen.getByText("GraphQL")).toBeInTheDocument();
  });

  it("renders 'WebSocket' for type=websocket", () => {
    render(<ConnectionTypeBadge type="websocket" />);
    expect(screen.getByText("WebSocket")).toBeInTheDocument();
  });

  it("renders the raw type for unknown values", () => {
    render(<ConnectionTypeBadge type="grpc" />);
    expect(screen.getByText("grpc")).toBeInTheDocument();
  });
});
