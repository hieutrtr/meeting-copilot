// experimental, not for prod — Phase 0 T-0.5 structural unit tests.
// These run with ZERO API key and zero spend; gate the request shape against
// docs/ARCHITECTURE.md §6.2 + §7.2 before any live call is made.

import { describe, expect, test } from "bun:test";
import {
  buildRequest,
  buildContextBlock,
  MODEL,
  MAX_TOKENS,
  TARGET_CONTEXT_CHARS,
} from "../src/buildPrompt.ts";

describe("T-0.5 request shape (ARCH §6.2 + §7.2)", () => {
  test("model is Sonnet 4.6", () => {
    const r = buildRequest();
    expect(r.model).toBe("claude-sonnet-4-6");
    expect(MODEL).toBe("claude-sonnet-4-6");
  });

  test("max_tokens is 600 (ARCH §7.2 example)", () => {
    const r = buildRequest();
    expect(r.max_tokens).toBe(600);
    expect(MAX_TOKENS).toBe(600);
  });

  test("temperature is 0 (deterministic for bench)", () => {
    expect(buildRequest().temperature).toBe(0);
  });

  test("system is an array of TWO cache breakpoints (ARCH §6.2)", () => {
    const r = buildRequest();
    expect(Array.isArray(r.system)).toBe(true);
    expect(r.system).toHaveLength(2);
    for (const block of r.system) {
      expect(block.type).toBe("text");
      expect(block.cache_control).toEqual({ type: "ephemeral" });
      expect(typeof block.text).toBe("string");
      expect(block.text.length).toBeGreaterThan(0);
    }
  });

  test("system[0] = static instructions, system[1] = context block", () => {
    const r = buildRequest();
    expect(r.system[0].text).toContain("Meeting Copilot");
    expect(r.system[1].text).toContain("Synthetic Context Block");
  });

  test("user message has TWO content parts: transcript + question (NOT cached)", () => {
    const r = buildRequest();
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].role).toBe("user");
    expect(r.messages[0].content).toHaveLength(2);

    const [transcript, question] = r.messages[0].content;
    expect(transcript.text.startsWith("Recent transcript")).toBe(true);
    expect(question.text.startsWith("Question detected:")).toBe(true);

    // Critical: user message parts MUST NOT have cache_control (ARCH §7.2 —
    // recentTranscript is volatile, must not be cached).
    for (const part of r.messages[0].content) {
      expect((part as any).cache_control).toBeUndefined();
    }
  });

  test("context block targets ~75k chars to clear 20k tokens with safety margin", () => {
    const ctx = buildContextBlock();
    expect(ctx.length).toBeGreaterThanOrEqual(TARGET_CONTEXT_CHARS);
    // Sanity: char/token rule of thumb says 75k chars ≈ 20-22k tokens. Hard
    // numeric verification happens post-API in the live bench (AC-4).
    expect(ctx.length).toBeLessThan(120_000); // not ridiculously over-padded
  });

  test("context block is deterministic across calls (cache hashing relies on this)", () => {
    expect(buildContextBlock()).toBe(buildContextBlock());
  });

  test("two consecutive buildRequest() calls produce byte-identical bodies", () => {
    // If this fails, prompt cache will MISS on call 2 because the cache key
    // depends on the exact bytes of the cache breakpoint contents.
    const a = JSON.stringify(buildRequest());
    const b = JSON.stringify(buildRequest());
    expect(a).toBe(b);
  });
});
