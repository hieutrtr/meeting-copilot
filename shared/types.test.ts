import { describe, it, expect } from "vitest";
import { SHARED_TYPES_SCHEMA_VERSION } from "@shared/types";
import type {
  TranscriptChunk,
  MeetingSession,
  QAEntry,
  Question,
} from "@shared/types";

describe("shared/types", () => {
  it("module resolves at runtime via @shared/types alias", () => {
    expect(SHARED_TYPES_SCHEMA_VERSION).toBe("1.0.0");
  });

  it("exports TranscriptChunk with the ARCH §3.1 + §10 shape", () => {
    const chunk: TranscriptChunk = {
      id: "c1",
      meetingId: "m1",
      text: "hello",
      startTs: 0,
      endTs: 1_000,
      isFinal: true,
    };
    expect(chunk.text).toBe("hello");
    expect(chunk.isFinal).toBe(true);
  });

  it("exports MeetingSession with the ARCH §10 Meeting shape", () => {
    const m: MeetingSession = {
      id: "m1",
      title: "Test meeting",
      startedAt: 1_700_000_000_000,
      status: "active",
    };
    expect(m.id).toBe("m1");
    expect(m.status).toBe("active");
  });

  it("exports QAEntry pairing Question + (nullable) Answer", () => {
    const q: Question = {
      id: "q1",
      meetingId: "m1",
      text: "Why?",
      detectedTs: 1_700_000_000_000,
      method: "manual",
    };
    const qa: QAEntry = { question: q, answer: null };
    expect(qa.question.text).toBe("Why?");
    expect(qa.answer).toBeNull();
  });
});
