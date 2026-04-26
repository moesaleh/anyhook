// Global test setup.
// 1. Extends Vitest's expect with the jest-dom matchers
//    (toBeInTheDocument, toHaveTextContent, toHaveClass, etc).
import "@testing-library/jest-dom/vitest";

// 2. Auto-cleanup between tests. Vitest doesn't enable React Testing
//    Library's automatic cleanup the way Jest does — we have to wire it.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
