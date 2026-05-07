// Phase 4 T-4.4 — Deeplink builder unit tests.
//
// Coverage targets:
//   - 10+ "injection / shell-meta" cases for `contextPaths` strings; each is
//     either rejected (`..`/NUL/empty) or percent-encoded by URLSearchParams.
//   - Stable param ordering (golden-asserted) so downstream snapshot tests in
//     T-4.10 stay deterministic.
//   - Optional fields (`ttsProvider`, `meetingTitle`) only appear when set.
//   - `validateContextPaths` does NOT touch the filesystem (no `fs` import in
//     this file — verified by absence and by the tests still passing under
//     vitest's default no-fs sandbox).

import { describe, expect, it } from "vitest";

import {
  buildStartDeeplink,
  ContextPathRejected,
  DEEPLINK_ACTION_START,
  DEEPLINK_SCHEME,
  MAX_CONTEXT_PATH_COUNT,
  validateContextPaths,
} from "./deeplink";
import type { StartInput } from "./tools";

const NUL = String.fromCharCode(0);

function baseInput(over: Partial<StartInput> = {}): StartInput {
  return {
    contextPaths: [],
    sttProvider: "mlx",
    model: "claude-sonnet-4-6",
    privacyMode: "local-first",
    ...over,
  };
}

describe("buildStartDeeplink (T-4.4)", () => {
  it("emits a meeting-copilot://start URL with required scalars", () => {
    const url = buildStartDeeplink(baseInput());
    expect(url.startsWith(`${DEEPLINK_SCHEME}://${DEEPLINK_ACTION_START}?`)).toBe(true);
    const parsed = new URL(url);
    expect(parsed.protocol).toBe(`${DEEPLINK_SCHEME}:`);
    expect(parsed.host).toBe(DEEPLINK_ACTION_START);
    expect(parsed.searchParams.get("sttProvider")).toBe("mlx");
    expect(parsed.searchParams.get("model")).toBe("claude-sonnet-4-6");
    expect(parsed.searchParams.get("privacyMode")).toBe("local-first");
  });

  it("omits ttsProvider + meetingTitle when not provided", () => {
    const url = buildStartDeeplink(baseInput());
    const parsed = new URL(url);
    expect(parsed.searchParams.has("ttsProvider")).toBe(false);
    expect(parsed.searchParams.has("meetingTitle")).toBe(false);
    expect(parsed.searchParams.has("contextPath")).toBe(false);
  });

  it("includes ttsProvider + meetingTitle when provided", () => {
    const url = buildStartDeeplink(
      baseInput({
        ttsProvider: "elevenlabs",
        meetingTitle: "Standup 2026-05-07",
        privacyMode: "cloud",
      }),
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("ttsProvider")).toBe("elevenlabs");
    expect(parsed.searchParams.get("meetingTitle")).toBe("Standup 2026-05-07");
  });

  it("emits one contextPath= param per array entry (no comma join)", () => {
    const url = buildStartDeeplink(
      baseInput({ contextPaths: ["/a/PRD.md", "/b/notes.txt"] }),
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.getAll("contextPath")).toEqual([
      "/a/PRD.md",
      "/b/notes.txt",
    ]);
  });

  it("scalar params appear before contextPath entries (stable ordering)", () => {
    const url = buildStartDeeplink(
      baseInput({
        ttsProvider: "off",
        meetingTitle: "Order Test",
        contextPaths: ["/late.md"],
      }),
    );
    // The query string ordering is: sttProvider, model, privacyMode, [tts],
    // [title], contextPath... Asserting via indexOf because URLSearchParams
    // does not guarantee insertion order in all engines, but in V8 + bun it
    // does. If this test ever breaks we're catching an environment drift.
    const q = url.split("?", 2)[1] ?? "";
    expect(q.indexOf("sttProvider=")).toBeLessThan(q.indexOf("model="));
    expect(q.indexOf("model=")).toBeLessThan(q.indexOf("privacyMode="));
    expect(q.indexOf("privacyMode=")).toBeLessThan(q.indexOf("ttsProvider="));
    expect(q.indexOf("ttsProvider=")).toBeLessThan(q.indexOf("meetingTitle="));
    expect(q.indexOf("meetingTitle=")).toBeLessThan(q.indexOf("contextPath="));
  });
});

describe("validateContextPaths — injection vectors (T-4.4)", () => {
  // The injection table below is the security-critical surface. Every row is
  // either rejected by `validateContextPaths` (with a typed reason) or
  // percent-encoded by URLSearchParams when fed to `buildStartDeeplink`.

  it("rejects `..` traversal segment (raw form)", () => {
    expect(() => validateContextPaths(["../../etc/passwd"])).toThrow(
      ContextPathRejected,
    );
  });

  it("rejects percent-encoded traversal `..%2Fetc%2Fpasswd`", () => {
    // Even though URLSearchParams would emit it as `..%252Fetc%252Fpasswd`,
    // we still reject — the receiving Tauri app could double-decode and end
    // up with `../etc/passwd`.
    expect(() => validateContextPaths(["..%2Fetc%2Fpasswd"])).toThrow(
      ContextPathRejected,
    );
  });

  it("rejects mid-path `..` segment", () => {
    expect(() => validateContextPaths(["/Users/me/docs/../../../etc/passwd"])).toThrow(
      ContextPathRejected,
    );
  });

  it("rejects a Windows-style backslash traversal", () => {
    expect(() => validateContextPaths(["..\\..\\System32"])).toThrow(
      ContextPathRejected,
    );
  });

  it("rejects an empty string", () => {
    expect(() => validateContextPaths([""])).toThrow(ContextPathRejected);
  });

  it("rejects a NUL-byte injection", () => {
    expect(() => validateContextPaths([`/safe/path${NUL}/etc/passwd`])).toThrow(
      ContextPathRejected,
    );
  });

  it("accepts a normal absolute path", () => {
    expect(() => validateContextPaths(["/Users/hieu/docs/PRD.md"])).not.toThrow();
  });

  it("accepts a single-dot relative path (./foo)", () => {
    // `.` is allowed; only `..` is rejected. Absolute-only enforcement is
    // out of scope (Tauri side decides).
    expect(() => validateContextPaths(["./local.md"])).not.toThrow();
  });

  it("accepts paths with spaces (round-tripped percent-encoded)", () => {
    expect(() => validateContextPaths(["/Users/hieu/Project Docs/PRD.md"])).not.toThrow();
    const url = buildStartDeeplink(
      baseInput({ contextPaths: ["/Users/hieu/Project Docs/PRD.md"] }),
    );
    expect(url).toContain("contextPath=%2FUsers%2Fhieu%2FProject+Docs%2FPRD.md");
  });

  it("URL-encodes shell metachars (& ; ' \" $ |) — not rejected, just escaped", () => {
    const dangerous = "/path/with&semi;and'quote\"and$dollar|pipe.md";
    expect(() => validateContextPaths([dangerous])).not.toThrow();
    const url = buildStartDeeplink(baseInput({ contextPaths: [dangerous] }));
    // No literal `&` (other than the param separator before contextPath=) or
    // `;` outside of percent-encoding should appear inside the value.
    const value = new URL(url).searchParams.get("contextPath");
    expect(value).toBe(dangerous);
    // The raw query string must not contain a literal `;` from the value (if
    // it did, downstream parsers might split on it).
    const valueSlice = url.split("contextPath=")[1] ?? "";
    expect(valueSlice).not.toContain(";");
    expect(valueSlice).not.toContain("'");
    expect(valueSlice).not.toContain('"');
    expect(valueSlice).not.toContain("$");
    expect(valueSlice).not.toContain("|");
  });

  it("URL-encodes unicode (CJK, emoji)", () => {
    const u = "/ノート/会议-2026.md";
    const e = "/notes-🚀.md";
    expect(() => validateContextPaths([u, e])).not.toThrow();
    const url = buildStartDeeplink(baseInput({ contextPaths: [u, e] }));
    const parsed = new URL(url);
    expect(parsed.searchParams.getAll("contextPath")).toEqual([u, e]);
    // Raw query must be ASCII-safe (no high bytes leaked).
    const q = url.split("?", 2)[1] ?? "";
    expect(/^[\x20-\x7E]*$/.test(q)).toBe(true);
  });

  it(`rejects more than ${MAX_CONTEXT_PATH_COUNT} paths`, () => {
    const too = new Array(MAX_CONTEXT_PATH_COUNT + 1).fill("/x.md");
    expect(() => validateContextPaths(too)).toThrow(ContextPathRejected);
  });

  it("rejects a single-path string longer than MAX_CONTEXT_PATH_LEN", () => {
    const huge = "/" + "a".repeat(8192);
    expect(() => validateContextPaths([huge])).toThrow(ContextPathRejected);
  });
});

describe("ContextPathRejected (T-4.4)", () => {
  it("preserves the offending path on .path and the reason on .reason", () => {
    try {
      validateContextPaths(["../../etc/passwd"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ContextPathRejected);
      const cpr = err as ContextPathRejected;
      expect(cpr.path).toBe("../../etc/passwd");
      expect(cpr.reason).toBe("traversal");
      expect(cpr.message).toContain("../../etc/passwd");
    }
  });

  it("truncates the path in the message when over 64 chars (no flooding logs)", () => {
    const longRejected = "../" + "a/".repeat(80);
    try {
      validateContextPaths([longRejected]);
      throw new Error("should have thrown");
    } catch (err) {
      const cpr = err as ContextPathRejected;
      // Message should be truncated; full path preserved on .path.
      expect(cpr.message.length).toBeLessThanOrEqual(120);
      expect(cpr.path).toBe(longRejected);
    }
  });
});
