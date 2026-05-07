// Phase 4 T-4.6 — handleStop unit tests.
//
// Focus: handler-level behaviour (path resolve + dial + discriminate + Zod
// re-parse). The lower-level dial/path logic is exhaustively covered in
// `socket.test.ts`; here we use a stub `dialSocket` to inject canned replies.

import { describe, expect, it, vi } from "vitest";

import { StopOutputSchema } from "../tools";
import type { dialSocket as DialSocketSig } from "../socket";
import { handleStop, type StopHandlerDeps } from "./stop";

type DialSocketCall = Parameters<typeof DialSocketSig>;

const SAMPLE_REPLY = {
  durationSec: 18,
  questionCount: 1,
};

const SAMPLE_REPLY_WITH_EXPORT = {
  exportedPath: "/Users/me/.claude-bridge/meeting-copilot/exports/m_1.md",
  durationSec: 42.5,
  questionCount: 3,
};

const NOT_FOUND_REPLY = {
  error: {
    code: "DaemonMeetingNotFound",
    message: 'no active meeting with id "m_ghost"',
  },
};

function depsReturning(reply: unknown): StopHandlerDeps {
  return {
    resolveSocketPathOpts: {
      env: {},
      homedir: () => "/tmp/home",
    },
    dialSocket: vi.fn(async () => reply),
  };
}

describe("handleStop — happy path (T-4.6)", () => {
  it("returns the parsed StopOutput envelope on success", async () => {
    const result = await handleStop(
      { meetingId: "m_1" },
      depsReturning(SAMPLE_REPLY),
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeTruthy();
    const parsed = StopOutputSchema.parse(result.structuredContent);
    expect(parsed.durationSec).toBe(18);
    expect(parsed.questionCount).toBe(1);
    expect(parsed.exportedPath).toBeUndefined();
  });

  it("includes exportedPath in the envelope when daemon returns it", async () => {
    const result = await handleStop(
      { meetingId: "m_1" },
      depsReturning(SAMPLE_REPLY_WITH_EXPORT),
    );
    expect(result.isError).toBeFalsy();
    const parsed = StopOutputSchema.parse(result.structuredContent);
    expect(parsed.exportedPath).toBe(
      "/Users/me/.claude-bridge/meeting-copilot/exports/m_1.md",
    );
    expect(parsed.durationSec).toBeCloseTo(42.5);
    expect(parsed.questionCount).toBe(3);
  });

  it("dials the resolved socket path with method:stop and the meetingId", async () => {
    const dial = vi.fn(async () => SAMPLE_REPLY);
    await handleStop(
      { meetingId: "m_42" },
      {
        resolveSocketPathOpts: { env: {}, homedir: () => "/tmp/home" },
        dialSocket: dial as unknown as typeof DialSocketSig,
      },
    );
    expect(dial).toHaveBeenCalledTimes(1);
    const call = dial.mock.calls[0] as unknown as DialSocketCall;
    const [path, request] = call;
    expect(path).toBe("/tmp/home/.claude-bridge/meeting-copilot.sock");
    expect(request).toEqual({ method: "stop", meetingId: "m_42" });
  });

  it("idempotent re-call returns identical envelope (daemon-side cache)", async () => {
    // Daemon-side idempotency means the same reply on every call. The handler
    // is pure transport — assert that two calls with the same args yield the
    // same envelope shape.
    const dial = vi.fn(async () => SAMPLE_REPLY_WITH_EXPORT);
    const deps: StopHandlerDeps = {
      resolveSocketPathOpts: { env: {}, homedir: () => "/tmp/home" },
      dialSocket: dial,
    };
    const a = await handleStop({ meetingId: "m_1" }, deps);
    const b = await handleStop({ meetingId: "m_1" }, deps);
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    expect(a.structuredContent).toEqual(b.structuredContent);
    expect(dial).toHaveBeenCalledTimes(2);
  });

  it("emits the structured envelope as JSON in content[0].text", async () => {
    const result = await handleStop(
      { meetingId: "m_1" },
      depsReturning(SAMPLE_REPLY),
    );
    const text = result.content[0]?.text ?? "";
    expect(text).toContain('"durationSec"');
    expect(text).toContain('"questionCount"');
    expect(text).toContain("18");
  });
});

describe("handleStop — MeetingNotFound (T-4.6)", () => {
  it("maps DaemonMeetingNotFound to a typed MeetingNotFound envelope", async () => {
    const result = await handleStop(
      { meetingId: "m_ghost" },
      depsReturning(NOT_FOUND_REPLY),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^MeetingNotFound:/);
    expect(result.content[0]?.text).toContain("m_ghost");
  });

  it("does not return structuredContent on the not-found path", async () => {
    const result = await handleStop(
      { meetingId: "m_ghost" },
      depsReturning(NOT_FOUND_REPLY),
    );
    expect(result.structuredContent).toBeUndefined();
  });
});

describe("handleStop — env override / path errors (T-4.6)", () => {
  it("rejects MCP_BRIDGE_HOME with `..` traversal as BridgeConfigInvalid", async () => {
    const dial = vi.fn(async () => SAMPLE_REPLY);
    const result = await handleStop(
      { meetingId: "m_1" },
      {
        resolveSocketPathOpts: {
          env: { MCP_BRIDGE_HOME: "/tmp/../etc" },
          homedir: () => "/u",
        },
        dialSocket: dial,
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^BridgeConfigInvalid:/);
    expect(result.content[0]?.text).toContain("traversal");
    // Critical: dial MUST NOT have been called on the rejection path.
    expect(dial).not.toHaveBeenCalled();
  });

  it("rejects MCP_BRIDGE_HOME with non-absolute value as BridgeConfigInvalid", async () => {
    const dial = vi.fn(async () => SAMPLE_REPLY);
    const result = await handleStop(
      { meetingId: "m_1" },
      {
        resolveSocketPathOpts: {
          env: { MCP_BRIDGE_HOME: "~/bridge" },
          homedir: () => "/u",
        },
        dialSocket: dial,
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^BridgeConfigInvalid:/);
    expect(result.content[0]?.text).toContain("not-absolute");
    expect(dial).not.toHaveBeenCalled();
  });

  it("uses MCP_BRIDGE_HOME when set to an absolute path", async () => {
    const dial = vi.fn(async () => SAMPLE_REPLY);
    await handleStop(
      { meetingId: "m_1" },
      {
        resolveSocketPathOpts: {
          env: { MCP_BRIDGE_HOME: "/var/run/bridge" },
          homedir: () => "/never",
        },
        dialSocket: dial as unknown as typeof DialSocketSig,
      },
    );
    const call = dial.mock.calls[0] as unknown as DialSocketCall;
    expect(call[0]).toBe("/var/run/bridge/meeting-copilot.sock");
  });
});

describe("handleStop — dial / schema errors (T-4.6)", () => {
  it("propagates a socket I/O error so server.ts maps it to isError envelope", async () => {
    const dial = vi.fn(async () => {
      throw new Error("ENOENT: helper-daemon socket missing");
    });
    await expect(
      handleStop(
        { meetingId: "m_1" },
        {
          resolveSocketPathOpts: { env: {}, homedir: () => "/u" },
          dialSocket: dial,
        },
      ),
    ).rejects.toThrow(/ENOENT/);
  });

  it("throws on a daemon reply that doesn't parse through StopOutputSchema", async () => {
    // negative durationSec — schema requires nonnegative
    const dial = vi.fn(async () => ({ durationSec: -1, questionCount: 0 }));
    await expect(
      handleStop(
        { meetingId: "m_1" },
        {
          resolveSocketPathOpts: { env: {}, homedir: () => "/u" },
          dialSocket: dial,
        },
      ),
    ).rejects.toThrow();
  });

  it("throws on an unknown daemon error code (preserves original message)", async () => {
    const dial = vi.fn(async () => ({
      error: { code: "DaemonExploded", message: "the kitchen is on fire" },
    }));
    await expect(
      handleStop(
        { meetingId: "m_1" },
        {
          resolveSocketPathOpts: { env: {}, homedir: () => "/u" },
          dialSocket: dial,
        },
      ),
    ).rejects.toThrow(/DaemonExploded|kitchen is on fire/);
  });
});

describe("handleStop — Zod strict (T-4.6)", () => {
  it("rejects missing meetingId (required field)", async () => {
    await expect(
      handleStop({}, depsReturning(SAMPLE_REPLY)),
    ).rejects.toThrow();
  });

  it("rejects non-string meetingId", async () => {
    await expect(
      handleStop({ meetingId: 42 }, depsReturning(SAMPLE_REPLY)),
    ).rejects.toThrow();
  });

  it("rejects unknown keys (strict)", async () => {
    await expect(
      handleStop(
        { meetingId: "m_1", extra: "no" },
        depsReturning(SAMPLE_REPLY),
      ),
    ).rejects.toThrow();
  });

  it("rejects empty-string meetingId (min(1))", async () => {
    await expect(
      handleStop({ meetingId: "" }, depsReturning(SAMPLE_REPLY)),
    ).rejects.toThrow();
  });
});
