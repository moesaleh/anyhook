import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeliveryStatusBadge } from "./delivery-status-badge";

describe("DeliveryStatusBadge", () => {
  it.each([
    ["success", "Success"],
    ["failed", "Failed"],
    ["retrying", "Retrying"],
    ["dlq", "DLQ"],
  ] as const)("renders %s as '%s'", (status, label) => {
    render(<DeliveryStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
