// @vitest-environment jsdom
//
// Phase 1 T-1.9 — `MeetingControls` component tests (jsdom pragma matches T-1.7/T-1.8).
//
// AC traceability (see docs/tasks/phase-1/T-1.9-meeting-controls.md):
//   MC-U1 → AC-3 (initial render: Start disabled, Stop/Mark hidden, status=idle)
//   MC-U2 → AC-3 (Start clickable once context loaded)
//   MC-U3 → AC-3 (Start click → status=active, Stop+Mark visible)
//   MC-U4 → AC-3 + AC-4 (Mark click → question store mutates from chunks prop)
//   MC-U5 → AC-3 (Stop click → status=ended, Start-new visible)

import "@testing-library/jest-dom/vitest";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { TranscriptChunk } from "../../shared/types";
import { MeetingControls } from "./MeetingControls";
import { useContextStore } from "../store/contextStore";
import { useMeetingStore } from "../store/meetingStore";
import { useQuestionStore } from "../store/questionStore";

const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn() as unknown as typeof originalScrollIntoView;
});
afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

beforeEach(() => {
  useMeetingStore.getState().reset();
  useQuestionStore.setState({ questions: [] });
  useContextStore.getState().clear();
  cleanup();
});

function chunk(idx: number, text: string): TranscriptChunk {
  return {
    id: `c-${idx}`,
    meetingId: "m-test",
    text,
    startTs: idx * 1_000,
    endTs: (idx + 1) * 1_000,
    isFinal: true,
  };
}

function loadFakeContext() {
  // bypass the Tauri invoke path — drive the store state directly so the component
  // observes a non-null source without spinning up the IPC mock.
  useContextStore.setState({
    source: {
      id: "/tmp/x.md",
      path: "/tmp/x.md",
      charCount: 1,
      estimatedTokens: 1,
      loadedAt: 0,
    },
    content: "x",
    error: null,
  });
}

describe("MeetingControls", () => {
  it("MC-U1: idle + no context → Start disabled, Stop/Mark hidden", () => {
    render(<MeetingControls chunks={[]} />);

    const start = screen.getByTestId("meeting-start-button") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.queryByTestId("meeting-stop-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("meeting-mark-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("meeting-status")).toHaveTextContent("idle");
  });

  it("MC-U2: loading a context source enables Start", () => {
    render(<MeetingControls chunks={[]} />);
    expect((screen.getByTestId("meeting-start-button") as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      loadFakeContext();
    });

    expect((screen.getByTestId("meeting-start-button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("MC-U3: Start click flips status to active and shows Stop + Mark", async () => {
    loadFakeContext();
    const user = userEvent.setup();
    render(<MeetingControls chunks={[]} />);

    await user.click(screen.getByTestId("meeting-start-button"));

    expect(screen.getByTestId("meeting-status")).toHaveTextContent("active");
    expect(screen.queryByTestId("meeting-start-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("meeting-stop-button")).toBeInTheDocument();
    expect(screen.getByTestId("meeting-mark-button")).toBeInTheDocument();
    expect(useMeetingStore.getState().status).toBe("active");
  });

  it("MC-U4: Mark click pushes a Question built from the last 3 chunks prop", async () => {
    loadFakeContext();
    const chunks = [
      chunk(0, "alpha"),
      chunk(1, "beta"),
      chunk(2, "charlie"),
      chunk(3, "delta"),
    ];

    const user = userEvent.setup();
    render(<MeetingControls chunks={chunks} />);

    await user.click(screen.getByTestId("meeting-start-button"));
    await user.click(screen.getByTestId("meeting-mark-button"));

    const list = useQuestionStore.getState().questions;
    expect(list).toHaveLength(1);
    expect(list[0]!.text).toBe("beta charlie delta");
    expect(list[0]!.method).toBe("manual");
    expect(useMeetingStore.getState().status).toBe("active");
  });

  it("MC-U4 (no-chunks-yet): Mark click is a no-op when chunks prop is empty", async () => {
    loadFakeContext();
    const user = userEvent.setup();
    render(<MeetingControls chunks={[]} />);

    await user.click(screen.getByTestId("meeting-start-button"));
    await user.click(screen.getByTestId("meeting-mark-button"));

    expect(useQuestionStore.getState().questions).toHaveLength(0);
  });

  it("MC-U5: Stop click flips status to ended and exposes Start-new", async () => {
    loadFakeContext();
    const user = userEvent.setup();
    render(<MeetingControls chunks={[]} />);

    await user.click(screen.getByTestId("meeting-start-button"));
    await user.click(screen.getByTestId("meeting-stop-button"));

    expect(screen.getByTestId("meeting-status")).toHaveTextContent("ended");
    expect(screen.queryByTestId("meeting-stop-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("meeting-mark-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("meeting-restart-button")).toBeInTheDocument();
    expect(useMeetingStore.getState().status).toBe("ended");
    expect(useMeetingStore.getState().endedAt).not.toBeNull();
  });

  it("ended → Start-new click resets and starts a fresh meeting", async () => {
    loadFakeContext();
    const user = userEvent.setup();
    render(<MeetingControls chunks={[]} />);

    await user.click(screen.getByTestId("meeting-start-button"));
    const firstId = useMeetingStore.getState().meetingId;
    await user.click(screen.getByTestId("meeting-stop-button"));
    await user.click(screen.getByTestId("meeting-restart-button"));

    expect(useMeetingStore.getState().status).toBe("active");
    expect(useMeetingStore.getState().meetingId).not.toBe(firstId);
  });
});
