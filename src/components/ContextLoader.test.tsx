// @vitest-environment jsdom
//
// Phase 1 T-1.8 — `ContextLoader` component tests (jsdom pragma, matching T-1.7).
//
// AC traceability (see docs/tasks/phase-1/T-1.8-context-loader.md):
//   CTX-U1 → AC-7 (initial render: input + button visible, no readout, no alert)
//   CTX-U2 → AC-7 (load happy path → readout shows path · chars · tokens)
//   CTX-U3 → AC-7 (load failure → [role=alert] shown with error)

import "@testing-library/jest-dom/vitest";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const { ContextLoader } = await import("./ContextLoader");
const { useContextStore } = await import("../store/contextStore");

const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn() as unknown as typeof originalScrollIntoView;
});
afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

beforeEach(() => {
  invokeMock.mockReset();
  useContextStore.getState().clear();
  cleanup();
});

describe("ContextLoader", () => {
  it("CTX-U1: renders input + button on first paint, no readout, no alert", () => {
    render(<ContextLoader />);

    expect(screen.getByLabelText(/context file path/i)).toBeInTheDocument();
    expect(screen.getByTestId("context-load-button")).toBeInTheDocument();
    expect(screen.queryByTestId("context-readout")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("CTX-U2: typing a path + clicking Load shows path · chars · tokens", async () => {
    invokeMock.mockResolvedValueOnce({
      path: "/Users/me/PRD.md",
      content: "x".repeat(120),
      charCount: 120,
      estimatedTokens: 30,
    });

    const user = userEvent.setup();
    render(<ContextLoader />);

    await user.type(screen.getByLabelText(/context file path/i), "/Users/me/PRD.md");
    await user.click(screen.getByTestId("context-load-button"));

    const readout = await screen.findByTestId("context-readout");
    expect(readout).toHaveTextContent("/Users/me/PRD.md");
    expect(readout).toHaveTextContent("120");
    expect(readout).toHaveTextContent("30");
    expect(readout).toHaveTextContent(/chars/i);
    expect(readout).toHaveTextContent(/tokens/i);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("CTX-U3: invoke rejection surfaces in [role=alert]", async () => {
    invokeMock.mockRejectedValueOnce(new Error("unsupported extension `pdf`"));

    const user = userEvent.setup();
    render(<ContextLoader />);

    await user.type(screen.getByLabelText(/context file path/i), "/tmp/doc.pdf");
    await user.click(screen.getByTestId("context-load-button"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/unsupported extension/i);
    expect(screen.queryByTestId("context-readout")).not.toBeInTheDocument();
  });

  it("Load button disabled when path is empty", () => {
    render(<ContextLoader />);
    const btn = screen.getByTestId("context-load-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("Clear button hidden until a source is loaded, then resets readout", async () => {
    invokeMock.mockResolvedValueOnce({
      path: "/tmp/a.txt",
      content: "abc",
      charCount: 3,
      estimatedTokens: 1,
    });

    const user = userEvent.setup();
    render(<ContextLoader />);

    expect(screen.queryByTestId("context-clear-button")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/context file path/i), "/tmp/a.txt");
    await user.click(screen.getByTestId("context-load-button"));
    await screen.findByTestId("context-readout");

    const clearBtn = screen.getByTestId("context-clear-button");
    await user.click(clearBtn);
    expect(screen.queryByTestId("context-readout")).not.toBeInTheDocument();
  });
});
