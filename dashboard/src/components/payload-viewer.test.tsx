import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PayloadViewer } from "./payload-viewer";

describe("PayloadViewer", () => {
  it("shows 'No payload data' when all three slots are null", () => {
    render(
      <PayloadViewer requestBody={null} responseBody={null} errorMessage={null} />
    );
    expect(screen.getByText(/No payload data/)).toBeInTheDocument();
  });

  it("shows headers for the slots that have content", () => {
    render(
      <PayloadViewer
        requestBody='{"a":1}'
        responseBody={null}
        errorMessage="boom"
      />
    );
    expect(screen.getByText("Request Body")).toBeInTheDocument();
    expect(screen.queryByText("Response Body")).not.toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("expands a section when its header is clicked", () => {
    render(
      <PayloadViewer
        requestBody='{"hello":"world"}'
        responseBody={null}
        errorMessage={null}
      />
    );
    fireEvent.click(screen.getByText("Request Body"));
    // Pretty-printed JSON shows up in the rendered <pre>
    expect(screen.getByText(/"hello": "world"/)).toBeInTheDocument();
  });

  it("falls back to raw text when content isn't valid JSON", () => {
    render(
      <PayloadViewer
        requestBody="not json"
        responseBody={null}
        errorMessage={null}
      />
    );
    fireEvent.click(screen.getByText("Request Body"));
    expect(screen.getByText("not json")).toBeInTheDocument();
  });

  it("shows the size in KB next to the section label", () => {
    const body = "x".repeat(2048); // 2KB
    render(
      <PayloadViewer requestBody={body} responseBody={null} errorMessage={null} />
    );
    // Size readout uses "(2KB)"
    expect(screen.getByText(/\(2KB\)/)).toBeInTheDocument();
  });

  describe("clipboard copy", () => {
    beforeEach(() => {
      // jsdom doesn't provide navigator.clipboard by default; stub it.
      Object.defineProperty(global.navigator, "clipboard", {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
      });
    });

    it("invokes clipboard.writeText with the formatted JSON when copy is clicked", async () => {
      render(
        <PayloadViewer
          requestBody='{"a":1,"b":2}'
          responseBody={null}
          errorMessage={null}
        />
      );
      fireEvent.click(screen.getByText("Request Body"));
      const copyBtn = screen.getByLabelText("Copy Request Body");
      fireEvent.click(copyBtn);
      // microtask flush
      await Promise.resolve();
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
      const arg = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(arg).toContain('"a": 1');
      expect(arg).toContain('"b": 2');
    });
  });
});
