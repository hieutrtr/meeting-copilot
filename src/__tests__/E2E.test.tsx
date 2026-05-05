// @vitest-environment jsdom
//
// Phase 1 T-1.13 — end-to-end vitest harness (E17..E22).
//
// Drives the full simulated golden-path:
//   render <App /> → load context → click Start → push transcript:chunk events
//   → click Mark question → mocked Claude streams answer → click Stop
//   → assert save_meeting was invoked with the expected snapshot.
// Plus the hydrate-on-load case: loadMeetings resolves with 1 row → the
// PastMeetings count reads "1 past meeting".
//
// Mocks:
//   @tauri-apps/api/core   — invoke dispatcher (per-command resolution)
//   @tauri-apps/api/event  — listen() seam (push events on demand)
//   @anthropic-ai/sdk      — fake Anthropic class with .on("text", …) +
//                             .finalMessage() (same shape as claudeClient.test.ts)

import "@testing-library/jest-dom/vitest";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { TranscriptChunk } from "../../shared/types";

// ── Tauri invoke mock ────────────────────────────────────────────────────────

interface InvokeRecorder {
  saveMeetingPayloads: unknown[];
  loadMeetingsCalls: number;
  loadMeetingsResponse: unknown[];
  contextResponse: {
    path: string;
    content: string;
    charCount: number;
    estimatedTokens: number;
  };
}

const invokeRecorder: InvokeRecorder = {
  saveMeetingPayloads: [],
  loadMeetingsCalls: 0,
  loadMeetingsResponse: [],
  contextResponse: {
    path: "/tmp/PRD.md",
    content: "Latency budget = 2 seconds.",
    charCount: 27,
    estimatedTokens: 7,
  },
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "read_context_file") {
      return invokeRecorder.contextResponse;
    }
    if (cmd === "save_meeting") {
      invokeRecorder.saveMeetingPayloads.push(args?.snapshot);
      return undefined;
    }
    if (cmd === "load_meetings") {
      invokeRecorder.loadMeetingsCalls += 1;
      return invokeRecorder.loadMeetingsResponse;
    }
    throw new Error(`unmocked tauri command: ${cmd}`);
  }),
}));

// ── Tauri event mock (transcript:chunk listener) ─────────────────────────────

type Listener<T> = (event: { payload: T; event: string; id: number }) => void;

const transcriptListeners: Array<Listener<TranscriptChunk>> = [];
const unlistenSpy = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (eventName: string, handler: Listener<TranscriptChunk>) => {
    if (eventName !== "transcript:chunk") {
      throw new Error(`unexpected event name: ${eventName}`);
    }
    transcriptListeners.push(handler);
    return unlistenSpy;
  }),
}));

function pushTranscript(payload: TranscriptChunk) {
  for (const handler of transcriptListeners) {
    handler({ payload, event: "transcript:chunk", id: 0 });
  }
}

// ── Anthropic SDK mock ───────────────────────────────────────────────────────

type TextListener = (text: string) => void;

interface SdkScript {
  deltas: string[];
  finalUsage: {
    input_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens: number;
  };
  stopReason?: string;
}

const sdkScript: { current: SdkScript } = {
  current: {
    deltas: ["The latency", " budget is 2", " seconds (per the PRD)."],
    finalUsage: {
      input_tokens: 1,
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 22_000,
      output_tokens: 30,
    },
    stopReason: "end_turn",
  },
};

class FakeStream {
  private listeners: TextListener[] = [];

  on(event: string, cb: unknown): this {
    if (event === "text") this.listeners.push(cb as TextListener);
    return this;
  }

  async finalMessage() {
    // Yield deltas one at a time across separate microtasks so the
    // `useAskClaude` consumer can observe intermediate snapshots
    // (E19 asserts mid-stream renders).
    for (const t of sdkScript.current.deltas) {
      for (const cb of this.listeners) cb(t);
      await Promise.resolve();
    }
    return {
      content: [{ type: "text", text: sdkScript.current.deltas.join("") }],
      usage: sdkScript.current.finalUsage,
      stop_reason: sdkScript.current.stopReason,
    };
  }
}

class FakeAnthropic {
  public messages: { stream: (body: unknown) => FakeStream };
  constructor(_opts: { apiKey: string }) {
    this.messages = {
      stream: (_body: unknown) => new FakeStream(),
    };
  }
}

vi.mock("@anthropic-ai/sdk", () => ({
  default: FakeAnthropic,
}));

// ── App import (after mocks) ─────────────────────────────────────────────────

const { default: App } = await import("../App");
const { useMeetingStore } = await import("../store/meetingStore");
const { useQuestionStore } = await import("../store/questionStore");
const { useContextStore } = await import("../store/contextStore");
const { useHistoryStore } = await import("../store/historyStore");

// scrollIntoView shim (TranscriptView calls it for autoscroll).
const originalScrollIntoView = Element.prototype.scrollIntoView;

const ENV_BACKUP = process.env.ANTHROPIC_API_KEY;

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn() as unknown as typeof originalScrollIntoView;
});

afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
  if (ENV_BACKUP === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ENV_BACKUP;
});

beforeEach(() => {
  invokeRecorder.saveMeetingPayloads.length = 0;
  invokeRecorder.loadMeetingsCalls = 0;
  invokeRecorder.loadMeetingsResponse = [];
  transcriptListeners.length = 0;
  unlistenSpy.mockClear();
  useMeetingStore.getState().reset();
  useQuestionStore.getState().clear();
  useContextStore.getState().clear();
  useHistoryStore.getState().clear();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterEach(() => {
  cleanup();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function chunk(idx: number, meetingId: string, text: string): TranscriptChunk {
  return {
    id: `${meetingId}-${idx}`,
    meetingId,
    text,
    startTs: idx * 1_000,
    endTs: (idx + 1) * 1_000,
    isFinal: true,
  };
}

async function loadContextThroughUi(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByLabelText("Context file path") as HTMLInputElement;
  await user.type(input, "/tmp/PRD.md");
  await user.click(screen.getByTestId("context-load-button"));
  // Wait for the readout to confirm context loaded (zustand store update settled).
  await waitFor(() =>
    expect(screen.getByTestId("context-readout")).toBeInTheDocument(),
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Meeting Copilot end-to-end (T-1.13)", () => {
  it("E17/E20/E21: full happy-path persists the snapshot on Stop", async () => {
    const user = userEvent.setup();
    render(<App />);

    // E1 — boot: every section renders.
    expect(screen.getByText("Meeting Copilot")).toBeInTheDocument();

    // E2 — load context.
    await loadContextThroughUi(user);

    // E3 — Start.
    const startBtn = screen.getByTestId("meeting-start-button") as HTMLButtonElement;
    expect(startBtn.disabled).toBe(false);
    await user.click(startBtn);
    expect(screen.getByTestId("meeting-status")).toHaveTextContent("active");

    // E4 — push 3 transcript chunks via the mocked listener.
    const meetingId = useMeetingStore.getState().meetingId!;
    expect(meetingId).toBeTruthy();
    const chunks = [
      chunk(0, meetingId, "Hi."),
      chunk(1, meetingId, "What"),
      chunk(2, meetingId, "is the ARR?"),
    ];
    await act(async () => {
      for (const c of chunks) pushTranscript(c);
      await Promise.resolve();
    });
    // Transcript view rendered the chunk text.
    await waitFor(() => {
      expect(screen.getByText(/is the ARR\?/)).toBeInTheDocument();
    });

    // E5/E20 — Mark question.
    await user.click(screen.getByTestId("meeting-mark-button"));
    const q0 = useQuestionStore.getState().questions[0];
    expect(q0.text).toBe("Hi. What is the ARR?");

    // E6/E19 — Streamed answer arrives. Wait for the final aggregated text.
    await waitFor(
      () => {
        const body = screen.getByTestId("answer-body");
        expect(body.textContent).toContain("seconds (per the PRD).");
      },
      { timeout: 3_000 },
    );

    // E7 — Stop.
    await user.click(screen.getByTestId("meeting-stop-button"));
    expect(screen.getByTestId("meeting-status")).toHaveTextContent("ended");

    // E21 — save_meeting fired exactly once with the expected shape.
    await waitFor(() => {
      expect(invokeRecorder.saveMeetingPayloads).toHaveLength(1);
    });
    const saved = invokeRecorder.saveMeetingPayloads[0] as {
      meeting: { id: string; status: string; endedAt?: number };
      chunks: TranscriptChunk[];
      questions: Array<{ id: string; text: string }>;
      answer: { text: string; questionId: string };
      contextSource: { id: string };
    };
    expect(saved.meeting.id).toBe(meetingId);
    expect(saved.meeting.status).toBe("ended");
    expect(saved.meeting.endedAt).toBeTypeOf("number");
    expect(saved.chunks).toHaveLength(3);
    expect(saved.chunks[0].text).toBe("Hi.");
    expect(saved.chunks[2].text).toBe("is the ARR?");
    expect(saved.questions).toHaveLength(1);
    expect(saved.questions[0].text).toBe("Hi. What is the ARR?");
    expect(saved.answer.text).toContain("latency budget");
    expect(saved.answer.questionId).toBe(saved.questions[0].id);
    expect(saved.contextSource.id).toBe("/tmp/PRD.md");
  });

  it("E18: hydrate-on-mount renders the past-meetings count", async () => {
    invokeRecorder.loadMeetingsResponse = [
      {
        id: "m-historic",
        title: "Historic sync",
        startedAt: 1,
        endedAt: 2,
        status: "ended",
      },
    ];
    render(<App />);
    await waitFor(() => {
      expect(invokeRecorder.loadMeetingsCalls).toBe(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("past-meetings-count")).toHaveTextContent(
        "1 past meeting",
      );
    });
    expect(screen.getByText(/Historic sync/)).toBeInTheDocument();
  });

  it("E22: console.error stays clean across the full happy path", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    render(<App />);
    await loadContextThroughUi(user);
    await user.click(screen.getByTestId("meeting-start-button"));
    await act(async () => {
      pushTranscript(chunk(0, useMeetingStore.getState().meetingId!, "hi"));
      await Promise.resolve();
    });
    await user.click(screen.getByTestId("meeting-mark-button"));
    await waitFor(() => {
      expect(screen.getByTestId("answer-body").textContent).toContain(
        "PRD",
      );
    });
    await user.click(screen.getByTestId("meeting-stop-button"));
    await waitFor(() =>
      expect(invokeRecorder.saveMeetingPayloads).toHaveLength(1),
    );
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
