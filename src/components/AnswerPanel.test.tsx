// @vitest-environment jsdom
//
// Phase 1 T-1.11 — `AnswerPanel` presentational tests (jsdom pragma).
//
// AC traceability (see docs/tasks/phase-1/T-1.11-answer-panel.md):
//   AP-S1  → AC-1 (idle render: placeholder, no Copy)
//   AP-S2  → AC-2 (incremental render across rerenders, root identity stable)
//   AP-S3  → AC-3 (markdown headings + lists)
//   AP-S4  → AC-3 (inline code + bold/italic)
//   AP-S5  → AC-3 (raw HTML escaped — XSS gate)
//   AP-S6  → AC-4 (Copy button visible only when status=done)
//   AP-S7  → AC-4 (Copy click → onCopy callback called with plain text + Copied! affordance)
//   AP-S8  → AC-4 (fallback to navigator.clipboard.writeText)
//   AP-S9  → AC-5 (cache-hit badge gated on > 0.5)
//   AP-S10 → AC-7 (cost readout 4dp)
//   AP-S11 → AC-6 (error fallback in [role=alert])
//   AP-S12 → AC-6 (paranoid: strip sk-ant- substrings before render)

import "@testing-library/jest-dom/vitest";

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AnswerPanel } from "./AnswerPanel";

afterEach(() => {
  cleanup();
});

describe("AnswerPanel — render states", () => {
  it("AP-S1: idle → placeholder visible, no Copy button", () => {
    render(<AnswerPanel status="idle" text="" />);
    expect(screen.getByTestId("answer-panel")).toHaveTextContent(/mark a question/i);
    expect(screen.queryByTestId("answer-copy")).not.toBeInTheDocument();
  });

  it("AP-S2: incremental rerenders update text without remounting the markdown root", () => {
    const { rerender } = render(<AnswerPanel status="streaming" text="Hello " />);
    const root1 = screen.getByTestId("answer-body");
    expect(root1).toHaveTextContent("Hello");

    rerender(<AnswerPanel status="streaming" text="Hello world" />);
    const root2 = screen.getByTestId("answer-body");
    expect(root2).toHaveTextContent("Hello world");
    // Same DOM node — no key churn / remount that would cause flicker.
    expect(root2).toBe(root1);
  });
});

describe("AnswerPanel — markdown render (AC-3)", () => {
  it("AP-S3: headings, unordered + ordered lists render to native HTML", () => {
    const md = ["## Sub", "", "- a", "- b", "", "1. one", "2. two"].join("\n");
    render(<AnswerPanel status="done" text={md} />);

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Sub");
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    const ul = screen.getByTestId("answer-body").querySelector("ul");
    const ol = screen.getByTestId("answer-body").querySelector("ol");
    expect(ul).not.toBeNull();
    expect(ol).not.toBeNull();
  });

  it("AP-S4: inline code + bold render to <code> + <strong>", () => {
    render(<AnswerPanel status="done" text="The **bold** word and `code`" />);
    const body = screen.getByTestId("answer-body");
    const strong = body.querySelector("strong");
    const code = body.querySelector("code");
    expect(strong?.textContent).toBe("bold");
    expect(code?.textContent).toBe("code");
  });

  it("AP-S5: raw HTML is escaped (XSS gate)", () => {
    render(<AnswerPanel status="done" text="<script>alert(1)</script> safe" />);
    const body = screen.getByTestId("answer-body");
    // `react-markdown` default config drops raw HTML — script must not be in the DOM.
    expect(body.querySelector("script")).toBeNull();
    // The literal text remains (escaped) so the user sees what was sent.
    expect(body.textContent).toContain("safe");
  });
});

describe("AnswerPanel — copy (AC-4)", () => {
  it("AP-S6: Copy button hidden while streaming", () => {
    render(<AnswerPanel status="streaming" text="partial" />);
    expect(screen.queryByTestId("answer-copy")).not.toBeInTheDocument();
  });

  it("AP-S6b: Copy button visible + enabled when done", () => {
    render(<AnswerPanel status="done" text="full answer" />);
    const btn = screen.getByTestId("answer-copy") as HTMLButtonElement;
    expect(btn).toBeInTheDocument();
    expect(btn.disabled).toBe(false);
  });

  it("AP-S7: Copy click invokes onCopy with the plain text + shows Copied!", async () => {
    const onCopy = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<AnswerPanel status="done" text="hello world" onCopy={onCopy} />);

    await user.click(screen.getByTestId("answer-copy"));

    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledWith("hello world");
    await waitFor(() => {
      expect(screen.getByTestId("answer-copy")).toHaveTextContent(/copied/i);
    });
  });

  it("AP-S8: falls back to navigator.clipboard.writeText when no onCopy provided", async () => {
    // Order matters: `userEvent.setup()` may stub navigator.clipboard for its
    // own copy/paste keyboard handling. We install our mock *after* setup so
    // the fallback path the component takes hits our spy.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const orig = (navigator as unknown as { clipboard?: unknown }).clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<AnswerPanel status="done" text="copyme" />);

    await user.click(screen.getByTestId("answer-copy"));

    expect(writeText).toHaveBeenCalledWith("copyme");

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: orig,
    });
  });
});

describe("AnswerPanel — usage / cost / cache (AC-5, AC-7)", () => {
  it("AP-S9: cache-hit badge shows when ratio > 0.5", () => {
    render(<AnswerPanel status="done" text="x" cacheReadRatio={0.92} />);
    expect(screen.getByTestId("cache-hit-badge")).toHaveTextContent(/cache hit/i);
    expect(screen.getByTestId("cache-hit-badge")).toHaveTextContent("92%");
  });

  it("AP-S9b: no badge when ratio ≤ 0.5 or undefined", () => {
    const { rerender } = render(<AnswerPanel status="done" text="x" cacheReadRatio={0.1} />);
    expect(screen.queryByTestId("cache-hit-badge")).not.toBeInTheDocument();
    rerender(<AnswerPanel status="done" text="x" />);
    expect(screen.queryByTestId("cache-hit-badge")).not.toBeInTheDocument();
  });

  it("AP-S10: cost readout renders to 4 decimal places when costUsd defined", () => {
    render(<AnswerPanel status="done" text="x" costUsd={0.0123} />);
    expect(screen.getByTestId("cost-readout")).toHaveTextContent("$0.0123");
  });

  it("AP-S10b: no cost readout when costUsd undefined", () => {
    render(<AnswerPanel status="done" text="x" />);
    expect(screen.queryByTestId("cost-readout")).not.toBeInTheDocument();
  });
});

describe("AnswerPanel — error (AC-6)", () => {
  it("AP-S11: error status renders [role=alert] with the error message", () => {
    render(
      <AnswerPanel status="error" text="" error={new Error("upstream 503 — retry later")} />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("upstream 503");
  });

  it("AP-S12: paranoid filter strips sk-ant- substrings from error message before render", () => {
    render(
      <AnswerPanel
        status="error"
        text=""
        error={new Error("api error: sk-ant-test1234567890 — retry")}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent ?? "").not.toContain("sk-ant-");
    expect(alert.textContent ?? "").toContain("retry");
  });
});
