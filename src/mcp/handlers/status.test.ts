// Phase 4 T-4.5 — handleStatus unit tests.
//
// Focus: handler-level behaviour (path resolve + dial + Zod re-parse + filter).
// The lower-level dial/path logic is exhaustively covered in `socket.test.ts`;
// here we use a stub `dialSocket` to inject canned replies.

import { describe, expect, it, vi } from "vitest";

import { StatusOutputSchema } from "../tools";
import type { dialSocket as DialSocketSig } from "../socket";
import { handleStatus, type StatusHandlerDeps } from "./status";

type DialSocketCall = Parameters<typeof DialSocketSig>;

const SAMPLE_REPLY = {
  meetings: [
    {
      id: "m_1",
      pid: 4242,
      startedAt: 1_700_000_000_000,
      sttProvider: "mlx",
      transcriptChunks: 12,
      questionCount: 1,
      answerCount: 1,
      uptimeSec: 18,
    },
    {
      id: "m_2",
      pid: 4243,
      startedAt: 1_700_000_010_000,
      sttProvider: "deepgram",
      transcriptChunks: 4,
      questionCount: 0,
      answerCount: 0,
      uptimeSec: 5,
    },
  ],
};

function depsReturning(reply: unknown): StatusHandlerDeps {
  return {
    resolveSocketPathOpts: {
      env: {},
      homedir: () => "/tmp/home",
    },
    dialSocket: vi.fn(async () => reply),
  };
}

describe("handleStatus — happy path (T-4.5)", () => {
  it("returns the full meetings list when no meetingId filter supplied", async () => {
    const result = await handleStatus({}, depsReturning(SAMPLE_REPLY));
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeTruthy();
    const parsed = StatusOutputSchema.parse(result.structuredContent);
    expect(parsed.meetings).toHaveLength(2);
    expect(parsed.meetings[0].id).toBe("m_1");
    expect(parsed.meetings[1].id).toBe("m_2");
  });

  it("dials the resolved socket path with method:status", async () => {
    const dial = vi.fn(async () => SAMPLE_REPLY);
    await handleStatus(
      {},
      {
        resolveSocketPathOpts: { env: {}, homedir: () => "/tmp/home" },
        dialSocket: dial as unknown as typeof DialSocketSig,
      },
    );
    expect(dial).toHaveBeenCalledTimes(1);
    const call = dial.mock.calls[0] as unknown as DialSocketCall;
    const [path, request] = call;
    expect(path).toBe("/tmp/home/.claude-bridge/meeting-copilot.sock");
    expect(request).toEqual({ method: "status" });
  });

  it("includes meetingId in the request when supplied", async () => {
    const dial = vi.fn(async () => ({ meetings: [SAMPLE_REPLY.meetings[0]] }));
    await handleStatus(
      { meetingId: "m_1" },
      {
        resolveSocketPathOpts: { env: {}, homedir: () => "/tmp/home" },
        dialSocket: dial as unknown as typeof DialSocketSig,
      },
    );
    const call = dial.mock.calls[0] as unknown as DialSocketCall;
    expect(call[1]).toEqual({ method: "status", meetingId: "m_1" });
  });

  it("returns the validated StatusOutput envelope (parses through Zod)", async () => {
    const result = await handleStatus({}, depsReturning(SAMPLE_REPLY));
    expect(() => StatusOutputSchema.parse(result.structuredContent)).not.toThrow();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain('"meetings"');
    expect(text).toContain('"m_1"');
  });

  it("idempotent re-query returns identical envelope", async () => {
    const dial = vi.fn(async () => SAMPLE_REPLY);
    const deps: StatusHandlerDeps = {
      resolveSocketPathOpts: { env: {}, homedir: () => "/tmp/home" },
      dialSocket: dial,
    };
    const a = await handleStatus({}, deps);
    const b = await handleStatus({}, deps);
    expect(a.structuredContent).toEqual(b.structuredContent);
    expect(dial).toHaveBeenCalledTimes(2);
  });
});

describe("handleStatus — meetingId filter (T-4.5)", () => {
  it("filters down to the matching meeting when daemon returns wider list", async () => {
    // Daemon returns both — the handler must filter down to just m_2.
    const result = await handleStatus(
      { meetingId: "m_2" },
      depsReturning(SAMPLE_REPLY),
    );
    expect(result.isError).toBeFalsy();
    const parsed = StatusOutputSchema.parse(result.structuredContent);
    expect(parsed.meetings).toHaveLength(1);
    expect(parsed.meetings[0].id).toBe("m_2");
  });

  it("returns MeetingNotFound when the filter matches no meetings", async () => {
    const result = await handleStatus(
      { meetingId: "m_nope" },
      depsReturning(SAMPLE_REPLY),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^MeetingNotFound:/);
    expect(result.content[0]?.text).toContain("m_nope");
  });
});

describe("handleStatus — env override / path errors (T-4.5)", () => {
  it("uses MCP_BRIDGE_HOME when set", async () => {
    const dial = vi.fn(async () => ({ meetings: [] }));
    await handleStatus(
      {},
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

  it("rejects MCP_BRIDGE_HOME with `..` traversal as BridgeConfigInvalid", async () => {
    const dial = vi.fn(async () => ({ meetings: [] }));
    const result = await handleStatus(
      {},
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
    const dial = vi.fn(async () => ({ meetings: [] }));
    const result = await handleStatus(
      {},
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
});

describe("handleStatus — dial / schema errors (T-4.5)", () => {
  it("propagates a socket I/O error so server.ts maps it to isError envelope", async () => {
    const dial = vi.fn(async () => {
      throw new Error("ENOENT: helper-daemon socket missing");
    });
    await expect(
      handleStatus(
        {},
        {
          resolveSocketPathOpts: { env: {}, homedir: () => "/u" },
          dialSocket: dial,
        },
      ),
    ).rejects.toThrow(/ENOENT/);
  });

  it("throws on a daemon reply that doesn't parse through StatusOutputSchema", async () => {
    const dial = vi.fn(async () => ({ meetings: [{ id: 42 }] }));
    await expect(
      handleStatus(
        {},
        {
          resolveSocketPathOpts: { env: {}, homedir: () => "/u" },
          dialSocket: dial,
        },
      ),
    ).rejects.toThrow();
  });
});

describe("handleStatus — Zod strict (T-4.5)", () => {
  it("rejects unknown keys in the request", async () => {
    await expect(
      handleStatus(
        { meetingId: "m_1", extra: "no" },
        depsReturning({ meetings: [] }),
      ),
    ).rejects.toThrow();
  });

  it("rejects non-string meetingId", async () => {
    await expect(
      handleStatus({ meetingId: 42 }, depsReturning({ meetings: [] })),
    ).rejects.toThrow();
  });
});
