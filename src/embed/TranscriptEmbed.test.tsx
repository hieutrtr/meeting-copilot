// @vitest-environment jsdom
//
// Phase 4 T-4.9 — `<TranscriptEmbed/>` component tests.
//
// Drives the SSE-driven iframe view through a hand-rolled `EventSource`
// mock. No network I/O — all events are dispatched via the mock's `push`.
// Covers the lifecycle (connecting → open → events → closed/errored), de-
// dupe behaviour, malformed-frame tolerance, and meeting-end freeze.

import "@testing-library/jest-dom/vitest";

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";

import {
  TranscriptEmbed,
  eventSourceUrl,
  formatTimestamp,
  initialState,
  reduce,
  type EventSourceLike,
} from "./TranscriptEmbed";
import type { EmbedEvent } from "./types";

// --- Mock EventSource -----------------------------------------------------

class MockEventSource implements EventSourceLike {
  url: string;
  onopen: ((this: EventSourceLike, ev: Event) => unknown) | null = null;
  onmessage: ((this: EventSourceLike, ev: MessageEvent<string>) => unknown) | null = null;
  onerror: ((this: EventSourceLike, ev: Event) => unknown) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
  }

  open(): void {
    this.onopen?.call(this, new Event("open"));
  }

  push(event: EmbedEvent): void {
    if (this.closed) return;
    this.onmessage?.call(
      this,
      new MessageEvent<string>("message", { data: JSON.stringify(event) }),
    );
  }

  pushRaw(raw: string): void {
    if (this.closed) return;
    this.onmessage?.call(this, new MessageEvent<string>("message", { data: raw }));
  }

  fail(): void {
    this.onerror?.call(this, new Event("error"));
  }

  close(): void {
    this.closed = true;
  }
}

afterEach(() => {
  cleanup();
});

// --- Reducer pure-function tests -----------------------------------------

describe("reduce", () => {
  it("appends a transcript chunk", () => {
    const s0 = initialState("m_1");
    const s1 = reduce(s0, {
      type: "event",
      event: {
        kind: "transcriptChunk",
        payload: {
          chunkId: "c1",
          speaker: "alice",
          text: "hello",
          startedAtMs: 0,
          endedAtMs: 100,
        },
      },
    });
    expect(s1.chunks).toHaveLength(1);
    expect(s1.chunks[0]?.text).toBe("hello");
  });

  it("de-dupes a re-delivered chunk by chunkId", () => {
    let s = initialState("m_1");
    const evt: EmbedEvent = {
      kind: "transcriptChunk",
      payload: {
        chunkId: "c1",
        speaker: "alice",
        text: "hello",
        startedAtMs: 0,
        endedAtMs: 100,
      },
    };
    s = reduce(s, { type: "event", event: evt });
    s = reduce(s, { type: "event", event: evt });
    expect(s.chunks).toHaveLength(1);
  });

  it("attaches an answer to the matching question", () => {
    let s = initialState("m_1");
    s = reduce(s, {
      type: "event",
      event: {
        kind: "question",
        payload: { questionId: "q1", text: "?", detectedAtMs: 100 },
      },
    });
    s = reduce(s, {
      type: "event",
      event: {
        kind: "answer",
        payload: {
          questionId: "q1",
          answerId: "a1",
          text: "yes",
          completedAtMs: 200,
        },
      },
    });
    expect(s.qaPairs[0]?.answer?.text).toBe("yes");
  });

  it("ignores an answer with no matching question", () => {
    let s = initialState("m_1");
    s = reduce(s, {
      type: "event",
      event: {
        kind: "answer",
        payload: {
          questionId: "q-nope",
          answerId: "a1",
          text: "orphan",
          completedAtMs: 100,
        },
      },
    });
    expect(s.qaPairs).toHaveLength(0);
  });

  it("freezes state on meetingEnded", () => {
    let s = initialState("m_1");
    s = reduce(s, {
      type: "event",
      event: { kind: "meetingEnded", payload: { endedAtMs: 999 } },
    });
    expect(s.ended).toBe(true);
    expect(s.endedAtMs).toBe(999);
  });

  it("updates the connection state via the dedicated action", () => {
    const s = reduce(initialState("m_1"), { type: "connection", state: "open" });
    expect(s.connection).toBe("open");
  });

  it("dedupes a question with the same questionId", () => {
    let s = initialState("m_1");
    const evt: EmbedEvent = {
      kind: "question",
      payload: { questionId: "q1", text: "first", detectedAtMs: 100 },
    };
    s = reduce(s, { type: "event", event: evt });
    s = reduce(s, { type: "event", event: evt });
    expect(s.qaPairs).toHaveLength(1);
  });
});

// --- URL + timestamp helpers ---------------------------------------------

describe("eventSourceUrl", () => {
  it("encodes the meetingId path segment + token query", () => {
    expect(eventSourceUrl("m_1", "abc-123")).toBe(
      "/embed/transcript/m_1/events?token=abc-123",
    );
  });

  it("percent-encodes a meetingId with characters that need escaping", () => {
    expect(eventSourceUrl("m/with slash", "t")).toBe(
      "/embed/transcript/m%2Fwith%20slash/events?token=t",
    );
  });

  it("percent-encodes special characters in the token", () => {
    expect(eventSourceUrl("m_1", "a&b=c")).toContain("token=a%26b%3Dc");
  });
});

describe("formatTimestamp", () => {
  it("formats whole hours, minutes, seconds, milliseconds", () => {
    expect(formatTimestamp(3_661_001)).toBe("01:01:01.001");
  });

  it("clamps negative inputs to the zero anchor", () => {
    expect(formatTimestamp(-100)).toBe("00:00:00.000");
  });

  it("clamps NaN inputs to the zero anchor", () => {
    expect(formatTimestamp(Number.NaN)).toBe("00:00:00.000");
  });
});

// --- Component lifecycle tests -------------------------------------------

describe("<TranscriptEmbed/>", () => {
  it("starts in the connecting state and transitions to open on factory open()", async () => {
    const sources: MockEventSource[] = [];
    render(
      <TranscriptEmbed
        meetingId="m_1"
        token="tok-1"
        eventSourceFactory={(url) => {
          const src = new MockEventSource(url);
          sources.push(src);
          return src;
        }}
      />,
    );

    expect(screen.getByTestId("connection-status")).toHaveTextContent("connecting");
    expect(sources).toHaveLength(1);
    expect(sources[0]?.url).toContain("/embed/transcript/m_1/events?token=tok-1");

    await act(async () => {
      sources[0]!.open();
    });
    expect(screen.getByTestId("connection-status")).toHaveTextContent("open");
  });

  it("renders transcript chunks pushed via the mock", async () => {
    const sources: MockEventSource[] = [];
    render(
      <TranscriptEmbed
        meetingId="m_1"
        token="tok-1"
        eventSourceFactory={(url) => {
          const src = new MockEventSource(url);
          sources.push(src);
          return src;
        }}
      />,
    );

    await act(async () => {
      sources[0]!.open();
      sources[0]!.push({
        kind: "transcriptChunk",
        payload: {
          chunkId: "c1",
          speaker: "alice",
          text: "hello",
          startedAtMs: 0,
          endedAtMs: 100,
        },
      });
    });

    const chunks = screen.getByTestId("chunks");
    expect(within(chunks).getByText("hello")).toBeInTheDocument();
    expect(within(chunks).getByText("alice")).toBeInTheDocument();
    expect(within(chunks).getByText("00:00:00.000")).toBeInTheDocument();
  });

  it("renders Q/A pairs after question + answer events", async () => {
    const sources: MockEventSource[] = [];
    render(
      <TranscriptEmbed
        meetingId="m_1"
        token="tok-1"
        eventSourceFactory={(url) => {
          const src = new MockEventSource(url);
          sources.push(src);
          return src;
        }}
      />,
    );

    await act(async () => {
      sources[0]!.open();
      sources[0]!.push({
        kind: "question",
        payload: { questionId: "q1", text: "what time?", detectedAtMs: 100 },
      });
      sources[0]!.push({
        kind: "answer",
        payload: {
          questionId: "q1",
          answerId: "a1",
          text: "noon",
          completedAtMs: 200,
        },
      });
    });

    const qa = screen.getByTestId("qa-pairs");
    expect(within(qa).getByText("what time?")).toBeInTheDocument();
    expect(within(qa).getByText("noon")).toBeInTheDocument();
  });

  it("transitions to error on EventSource onerror", async () => {
    const sources: MockEventSource[] = [];
    render(
      <TranscriptEmbed
        meetingId="m_1"
        token="tok-1"
        eventSourceFactory={(url) => {
          const src = new MockEventSource(url);
          sources.push(src);
          return src;
        }}
      />,
    );

    await act(async () => {
      sources[0]!.fail();
    });
    expect(screen.getByTestId("connection-status")).toHaveTextContent("error");
  });

  it("ignores malformed JSON frames without crashing", async () => {
    const sources: MockEventSource[] = [];
    render(
      <TranscriptEmbed
        meetingId="m_1"
        token="tok-1"
        eventSourceFactory={(url) => {
          const src = new MockEventSource(url);
          sources.push(src);
          return src;
        }}
      />,
    );

    await act(async () => {
      sources[0]!.open();
      sources[0]!.pushRaw("{not-json"); // would throw if we let it
      sources[0]!.push({
        kind: "transcriptChunk",
        payload: {
          chunkId: "c1",
          speaker: "alice",
          text: "ok",
          startedAtMs: 0,
          endedAtMs: 100,
        },
      });
    });

    const chunks = screen.getByTestId("chunks");
    expect(within(chunks).getByText("ok")).toBeInTheDocument();
  });

  it("closes the EventSource on unmount", async () => {
    const sources: MockEventSource[] = [];
    const { unmount } = render(
      <TranscriptEmbed
        meetingId="m_1"
        token="tok-1"
        eventSourceFactory={(url) => {
          const src = new MockEventSource(url);
          sources.push(src);
          return src;
        }}
      />,
    );

    expect(sources[0]?.closed).toBe(false);
    unmount();
    expect(sources[0]?.closed).toBe(true);
  });

  it("freezes the footer to 'Ended' on meetingEnded", async () => {
    const sources: MockEventSource[] = [];
    render(
      <TranscriptEmbed
        meetingId="m_1"
        token="tok-1"
        eventSourceFactory={(url) => {
          const src = new MockEventSource(url);
          sources.push(src);
          return src;
        }}
      />,
    );

    await act(async () => {
      sources[0]!.open();
      sources[0]!.push({
        kind: "meetingEnded",
        payload: { endedAtMs: 12345 },
      });
    });
    expect(screen.getByTestId("footer")).toHaveTextContent("Ended");
  });

  it("uses the default factory (window.EventSource) when none is provided", async () => {
    // Stub the global EventSource so we don't touch the network. We assign
    // the constructor directly (not via `vi.fn()` — the spy wrapper is not
    // itself a constructor under jsdom, which `Reflect.construct`-rejects).
    const created: GlobalMock[] = [];

    class GlobalMock {
      url: string;
      closed = false;
      onopen: ((ev: Event) => unknown) | null = null;
      onmessage: ((ev: MessageEvent<string>) => unknown) | null = null;
      onerror: ((ev: Event) => unknown) | null = null;
      constructor(url: string) {
        this.url = url;
        created.push(this);
      }
      close() {
        this.closed = true;
      }
    }

    const original = (globalThis as { EventSource?: typeof EventSource }).EventSource;
    (globalThis as { EventSource?: unknown }).EventSource = GlobalMock;

    try {
      const { unmount } = render(<TranscriptEmbed meetingId="m_x" token="tok-x" />);
      expect(created).toHaveLength(1);
      expect(created[0]!.url).toContain("/embed/transcript/m_x/events?token=tok-x");
      unmount();
      expect(created[0]!.closed).toBe(true);
    } finally {
      if (original) {
        (globalThis as { EventSource?: typeof EventSource }).EventSource = original;
      } else {
        delete (globalThis as { EventSource?: unknown }).EventSource;
      }
    }
  });
});
